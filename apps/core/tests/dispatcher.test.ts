import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawNotification, User } from '@tec-brain/types';

const db = {
  getNotificationState: vi.fn(),
  insertNotification: vi.fn(),
  updateNotificationDocumentStatus: vi.fn(),
  uploadedFileExists: vi.fn(),
  insertUploadedFile: vi.fn(),
  upsertCourseMapping: vi.fn().mockResolvedValue(undefined),
  getCourseMapping: vi.fn().mockResolvedValue(null),
  isAnyCourseMuted: vi.fn(),
  resolveCourseEntry: vi.fn(),
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
    onedrive_root_folder_id: null,
    storage_provider: 'none',
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
    db.isAnyCourseMuted.mockResolvedValue(false);
    db.resolveCourseEntry.mockResolvedValue({
      key: 'code:el2207',
      label: 'EL2207 - Curso',
      legacyKey: 'el2207',
      code: 'EL2207',
      name: 'Curso',
      isUnknown: false,
    });
  });

  it('returns duplicate when notification already processed', async () => {
    db.getNotificationState.mockResolvedValue({ exists: true, document_status: 'resolved' });

    const { dispatch } = await import('../src/dispatcher.js');
    const result = await dispatch(
      user,
      notification,
      'http://scraper',
      'password',
      {
        sendNotice: vi.fn(),
        sendEvaluation: vi.fn(),
        sendDocumentsSaved: vi.fn(),
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
      'http://scraper',
      'password',
      {
        sendNotice: vi.fn().mockRejectedValue(new Error('telegram down')),
        sendEvaluation: vi.fn(),
        sendDocumentsSaved: vi.fn(),
        sendDocumentLink: vi.fn(),
      } as any,
      null,
    );

    expect(result).toEqual({ processed: false, reason: 'partial_or_failed' });
    expect(db.insertNotification).not.toHaveBeenCalled();
  });

  it('notifies user when drive auth expires during upload', async () => {
    const userWithDrive: User = {
      ...user,
      drive_root_folder_id: 'root123',
      storage_provider: 'drive',
    };

    const docNotification: RawNotification = {
      ...notification,
      type: 'documento',
      files: [
        {
          file_name: 'archivo.pdf',
          download_url: 'https://tecdigital.tec.ac.cr/file.pdf',
        },
      ],
    } as RawNotification;

    db.getNotificationState.mockResolvedValue({ exists: false, document_status: null });
    db.uploadedFileExists.mockResolvedValue(false);
    db.insertUploadedFile.mockResolvedValue(undefined);

    const telegram = {
      sendNotice: vi.fn(),
      sendEvaluation: vi.fn(),
      sendDocumentsSaved: vi.fn(),
      sendDocumentsDownload: vi.fn().mockResolvedValue(undefined),
      sendDocumentLink: vi.fn(),
      sendDriveAuthExpired: vi.fn().mockResolvedValue(undefined),
    } as any;

    const drive = {
      ensureFolder: vi.fn().mockResolvedValue('folder123'),
      downloadAndUpload: vi.fn().mockRejectedValue(new Error('invalid_grant')),
    } as any;

    const { dispatch } = await import('../src/dispatcher.js');
    await dispatch(userWithDrive, docNotification, 'http://scraper', '', telegram, drive);

    expect(telegram.sendDriveAuthExpired).toHaveBeenCalledTimes(1);
  });

  it('marks document fallback when drive disabled', async () => {
    const docNotification: RawNotification = {
      ...notification,
      type: 'documento',
      files: [
        {
          file_name: 'archivo.pdf',
          download_url: 'https://tecdigital.tec.ac.cr/file.pdf',
        },
      ],
    } as RawNotification;

    db.getNotificationState.mockResolvedValue({ exists: false, document_status: null });
    db.uploadedFileExists.mockResolvedValue(false);

    const telegram = {
      sendNotice: vi.fn(),
      sendEvaluation: vi.fn(),
      sendDocumentsSaved: vi.fn(),
      sendDocumentsDownload: vi.fn().mockResolvedValue(undefined),
      sendDocumentLink: vi.fn(),
      sendDriveAuthExpired: vi.fn(),
    } as any;

    const { dispatch } = await import('../src/dispatcher.js');
    await dispatch(user, docNotification, 'http://scraper', '', telegram, null);

    expect(db.insertUploadedFile).toHaveBeenCalledWith(
      user.id,
      docNotification.course,
      expect.any(String),
      'archivo.pdf',
      'fallback',
    );
    expect(db.insertNotification).toHaveBeenCalled();
  });

  it('skips muted courses without dispatching', async () => {
    db.getNotificationState.mockResolvedValue({ exists: false, document_status: null });
    db.isAnyCourseMuted.mockResolvedValue(true);

    const { dispatch } = await import('../src/dispatcher.js');
    const sendNotice = vi.fn();
    const result = await dispatch(
      user,
      notification,
      'http://scraper',
      'password',
      {
        sendNotice,
        sendEvaluation: vi.fn(),
        sendDocumentSaved: vi.fn(),
        sendDocumentLink: vi.fn(),
      } as any,
      null,
    );

    expect(result).toEqual({ processed: true, reason: 'muted' });
    expect(sendNotice).not.toHaveBeenCalled();
    expect(db.insertNotification).toHaveBeenCalledTimes(1);
  });
});
