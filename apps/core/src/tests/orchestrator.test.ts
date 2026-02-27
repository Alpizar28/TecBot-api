import { describe, it, expect, vi } from 'vitest';

// ─── Test: Deduplication Logic ────────────────────────────────────────────────

describe('getNotificationState', () => {
    it('returns exists true with document status', async () => {
        vi.mock('@tec-brain/database', () => ({
            getNotificationState: vi.fn().mockResolvedValue({ exists: true, document_status: 'resolved' }),
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
        expect(message).toContain('Evaluación');
    });
});
