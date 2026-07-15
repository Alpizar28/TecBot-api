import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Test: Admin alert cooldown ───────────────────────────────────────────────

describe('selectAlertsToSend', () => {
  const COOLDOWN = 60 * 60_000; // 60 min
  const alerts = [{ key: 'users_failed', text: 'users_failed=1/3' }];

  // orchestrator.ts instantiates a TelegramService singleton at import time,
  // which requires a token — set one before importing the module under test.
  let selectAlertsToSend: typeof import('../orchestrator.js')['selectAlertsToSend'];
  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    ({ selectAlertsToSend } = await import('../orchestrator.js'));
  });

  it('sends an alert the first time its key is seen', () => {
    const timestamps: Record<string, number> = {};
    const toSend = selectAlertsToSend(alerts, timestamps, 1_000, COOLDOWN);
    expect(toSend).toHaveLength(1);
    expect(timestamps.users_failed).toBe(1_000);
  });

  it('suppresses the same alert key within the cooldown window', () => {
    const timestamps: Record<string, number> = {};
    selectAlertsToSend(alerts, timestamps, 1_000, COOLDOWN);
    const second = selectAlertsToSend(alerts, timestamps, 1_000 + COOLDOWN - 1, COOLDOWN);
    expect(second).toHaveLength(0);
  });

  it('re-sends the alert once the cooldown has elapsed', () => {
    const timestamps: Record<string, number> = {};
    selectAlertsToSend(alerts, timestamps, 1_000, COOLDOWN);
    const later = selectAlertsToSend(alerts, timestamps, 1_000 + COOLDOWN, COOLDOWN);
    expect(later).toHaveLength(1);
    expect(timestamps.users_failed).toBe(1_000 + COOLDOWN);
  });

  it('tracks cooldowns independently per alert key', () => {
    const timestamps: Record<string, number> = { users_failed: 1_000 };
    const mixed = [
      { key: 'users_failed', text: 'users_failed=1/3' },
      { key: 'notifications_partial', text: 'notifications_partial=2/5 (40%)' },
    ];
    const toSend = selectAlertsToSend(mixed, timestamps, 1_500, COOLDOWN);
    expect(toSend.map((a) => a.key)).toEqual(['notifications_partial']);
  });
});

// ─── Test: Deduplication Logic ────────────────────────────────────────────────

describe('getNotificationState', () => {
  it('returns exists true with document status', async () => {
    vi.mock('@tec-brain/database', () => ({
      getNotificationState: vi
        .fn()
        .mockResolvedValue({ exists: true, document_status: 'resolved' }),
    }));

    const { getNotificationState } = await import('@tec-brain/database');
    const result = await getNotificationState('user-uuid', 'notif_abc123');
    expect(result.exists).toBe(true);
    expect(result.document_status).toBe('resolved');
  });

  it('returns exists false when notification is new', async () => {
    const { getNotificationState } = await import('@tec-brain/database');
    vi.mocked(getNotificationState).mockResolvedValueOnce({ exists: false, document_status: null });
    const result = await getNotificationState('user-uuid', 'notif_xyz999');
    expect(result.exists).toBe(false);
  });
});

// ─── Test: Telegram Message Formatter ────────────────────────────────────────

describe('Telegram message formatters', () => {
  const mockUser = {
    id: 'u1',
    name: 'Pablo',
    tec_username: 'j.alpizar@estudiantec.cr',
    tec_password_enc: 'encrypted',
    telegram_chat_id: '6317692621',
    drive_root_folder_id: 'folder-id',
    onedrive_root_folder_id: null,
    storage_provider: 'drive' as const,
    studyos_url: null,
    studyos_token_enc: null,
    is_active: true,
    created_at: new Date(),
  };

  const mockNotification = {
    external_id: 'notif_001',
    type: 'evaluacion' as const,
    course: 'Cálculo Superior',
    title: 'Examen Parcial 1',
    description: 'Examen Parcial — Temas 1 al 5',
    link: 'https://tecdigital.tec.ac.cr/exam',
    date: '2026-02-28',
  };

  it('sends evaluation notification via Telegram without throwing', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    const { TelegramService } = await import('@tec-brain/telegram');
    vi.spyOn(TelegramService.prototype, 'sendMessage').mockImplementation(mockSend);

    const svc = new TelegramService('fake-token');
    await svc.sendEvaluation(mockUser, mockNotification);

    expect(mockSend).toHaveBeenCalledOnce();
    const [chatId, message] = mockSend.mock.calls[0] as [string, string];
    expect(chatId).toBe('6317692621');
    expect(message).toContain('Cálculo Superior');
    expect(message).toContain('Ver evaluación en TEC Digital');
  });

  it('escapes quotes and angle brackets in link URLs to prevent HTML injection', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    const { TelegramService } = await import('@tec-brain/telegram');
    vi.spyOn(TelegramService.prototype, 'sendMessage').mockImplementation(mockSend);

    const svc = new TelegramService('fake-token');
    await svc.sendEvaluation(mockUser, {
      ...mockNotification,
      link: 'https://evil.example/"><script>alert(1)</script>',
    });

    const [, message] = mockSend.mock.calls[0] as [string, string];
    // The raw breakout sequence must not survive into the message.
    expect(message).not.toContain('"><script>');
    expect(message).toContain('&quot;&gt;&lt;script&gt;');
  });
});
