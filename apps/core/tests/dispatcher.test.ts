import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawNotification, User } from '@tec-brain/types';

const db = {
  getNotificationState: vi.fn(),
  insertNotification: vi.fn(),
  updateNotificationDocumentStatus: vi.fn(),
  uploadedFileExists: vi.fn(),
  insertUploadedFile: vi.fn(),
};

vi.mock('@tec-brain/database', () => db);

describe('dispatch()', () => {
  const user: User = {
    id: 'u1',
    name: 'Pablo',
    tec_username: 'pablo@estudiantec.cr',
    tec_password_enc: 'enc',
    telegram_chat_id: '123',
    drive_root_folder_id: null,
    is_active: true,
    created_at: new Date(),
  };

  const notification: RawNotification = {
    external_id: 'notif_1',
    type: 'noticia',
    course: 'EL2207',
    title: 'Aviso',
    description: 'Se actualizo anuncio',
    link: 'https://tecdigital.tec.ac.cr/x',
    date: '2026-02-27',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns duplicate when notification already processed', async () => {
    db.getNotificationState.mockResolvedValue({ exists: true, document_status: 'resolved' });

    const { dispatch } = await import('../src/dispatcher.js');
    const result = await dispatch(
      user,
      notification,
      [],
      {
        sendNotice: vi.fn(),
        sendEvaluation: vi.fn(),
        sendDocumentSaved: vi.fn(),
        sendDocumentLink: vi.fn(),
      } as any,
      null,
    );

    expect(result).toEqual({ processed: true, reason: 'duplicate' });
    expect(db.insertNotification).not.toHaveBeenCalled();
  });

  it('returns partial_or_failed when telegram send fails', async () => {
    db.getNotificationState.mockResolvedValue({ exists: false, document_status: null });

    const { dispatch } = await import('../src/dispatcher.js');
    const result = await dispatch(
      user,
      notification,
      [],
      {
        sendNotice: vi.fn().mockRejectedValue(new Error('telegram down')),
        sendEvaluation: vi.fn(),
        sendDocumentSaved: vi.fn(),
        sendDocumentLink: vi.fn(),
      } as any,
      null,
    );

    expect(result).toEqual({ processed: false, reason: 'partial_or_failed' });
    expect(db.insertNotification).not.toHaveBeenCalled();
  });
});
