import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Test: Admin alert transitions ────────────────────────────────────────────

describe('selectAlertTransitions', () => {
  const REMIND = 6 * 60 * 60_000; // 6 h
  const alerts = [{ key: 'users_failed', text: 'users_failed=1/3' }];

  // orchestrator.ts instantiates a TelegramService singleton at import time,
  // which requires a token — set one before importing the module under test.
  let selectAlertTransitions: typeof import('../orchestrator.js')['selectAlertTransitions'];
  let dominantDispatchError: typeof import('../orchestrator.js')['dominantDispatchError'];
  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    ({ selectAlertTransitions, dominantDispatchError } = await import('../orchestrator.js'));
  });

  it('fires an alert the first time its key is seen', () => {
    const state: Record<string, number> = {};
    const out = selectAlertTransitions(alerts, state, 1_000, REMIND);
    expect(out).toEqual([{ key: 'users_failed', text: 'users_failed=1/3', kind: 'fired' }]);
    expect(state.users_failed).toBe(1_000);
  });

  it('stays silent while the alert persists within the remind window', () => {
    const state: Record<string, number> = {};
    selectAlertTransitions(alerts, state, 1_000, REMIND);
    const second = selectAlertTransitions(alerts, state, 1_000 + REMIND - 1, REMIND);
    expect(second).toHaveLength(0);
  });

  it('sends a reminder once the remind window elapses', () => {
    const state: Record<string, number> = {};
    selectAlertTransitions(alerts, state, 1_000, REMIND);
    const later = selectAlertTransitions(alerts, state, 1_000 + REMIND, REMIND);
    expect(later).toEqual([{ key: 'users_failed', text: 'users_failed=1/3', kind: 'reminder' }]);
    expect(state.users_failed).toBe(1_000 + REMIND);
  });

  it('emits a recovery notice when the alert stops firing', () => {
    const state: Record<string, number> = {};
    selectAlertTransitions(alerts, state, 1_000, REMIND);
    const out = selectAlertTransitions([], state, 2_000, REMIND);
    expect(out).toEqual([{ key: 'users_failed', text: '', kind: 'recovered' }]);
    expect(state.users_failed).toBeUndefined();
  });

  it('handles keys independently: one recovers while another fires', () => {
    const state: Record<string, number> = { users_failed: 1_000 };
    const out = selectAlertTransitions(
      [{ key: 'notifications_partial', text: 'partial=2/5 (40%)' }],
      state,
      1_500,
      REMIND,
    );
    expect(out.map((t) => [t.key, t.kind])).toEqual([
      ['users_failed', 'recovered'],
      ['notifications_partial', 'fired'],
    ]);
  });

  it('dominantDispatchError returns the most frequent message with its count', () => {
    expect(dominantDispatchError([])).toBeNull();
    expect(
      dominantDispatchError([
        'drive_upload: invalid_grant',
        'telegram_notice: 400',
        'drive_upload: invalid_grant',
      ]),
    ).toBe('drive_upload: invalid_grant (2/3)');
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
