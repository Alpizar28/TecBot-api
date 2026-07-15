import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawNotification, User } from '@tec-brain/types';

const db = {
  decrypt: vi.fn((v: string) => v.replace('enc:', '')),
  getNotificationId: vi.fn(),
  markStudyosDelivered: vi.fn().mockResolvedValue(undefined),
  recordStudyosFailure: vi.fn().mockResolvedValue(undefined),
  getPendingStudyosNotifications: vi.fn().mockResolvedValue([]),
  resolveCourseEntry: vi.fn().mockResolvedValue({
    key: 'code:el2207',
    legacyKey: 'el2207',
    code: 'EL2207',
    name: 'Circuitos',
    label: 'EL2207 - Circuitos',
    isUnknown: false,
  }),
};

vi.mock('@tec-brain/database', () => db);

const baseUser: User = {
  id: 'u1',
  name: 'Pablo',
  tec_username: 'pablo@estudiantec.cr',
  tec_password_enc: 'enc:pwd',
  telegram_chat_id: '123',
  drive_root_folder_id: null,
  onedrive_root_folder_id: null,
  storage_provider: 'none',
  studyos_url: 'https://study.alpizar.dev/',
  studyos_token_enc: 'enc:tok',
  is_active: true,
  created_at: new Date(),
};

const notification: RawNotification = {
  external_id: 'notif_1',
  type: 'evaluacion',
  course: 'EL2207',
  title: 'Tarea 3',
  description: 'Entrega el 20 de julio',
  link: 'https://tecdigital.tec.ac.cr/x',
  date: '2026-07-14',
};

beforeEach(() => {
  vi.clearAllMocks();
  db.decrypt.mockImplementation((v: string) => v.replace('enc:', ''));
  db.resolveCourseEntry.mockResolvedValue({
    key: 'code:el2207',
    legacyKey: 'el2207',
    code: 'EL2207',
    name: 'Circuitos',
    label: 'EL2207 - Circuitos',
    isUnknown: false,
  });
});

describe('getStudyosTarget()', () => {
  it('returns null when the user has no StudyOS configured', async () => {
    const { getStudyosTarget } = await import('../src/studyos.js');
    expect(getStudyosTarget({ ...baseUser, studyos_url: null })).toBeNull();
    expect(getStudyosTarget({ ...baseUser, studyos_token_enc: null })).toBeNull();
  });

  it('strips trailing slash and decrypts the token', async () => {
    const { getStudyosTarget } = await import('../src/studyos.js');
    expect(getStudyosTarget(baseUser)).toEqual({
      url: 'https://study.alpizar.dev',
      token: 'tok',
    });
  });
});

describe('buildItemPayload()', () => {
  it('maps a raw notification to the schema_version 1 contract', async () => {
    const { buildItemPayload } = await import('../src/studyos.js');
    const p = buildItemPayload(notification, 'code:el2207', '2026-07-14T12:00:00Z');
    expect(p).toEqual({
      schema_version: 1,
      external_id: 'notif_1',
      type: 'evaluacion',
      course: { key: 'code:el2207', code: 'EL2207', name: 'EL2207' },
      title: 'Tarea 3',
      body: 'Entrega el 20 de julio',
      link: 'https://tecdigital.tec.ac.cr/x',
      published_at: '2026-07-14',
      detected_at: '2026-07-14T12:00:00Z',
      files: [],
    });
  });

  it('prefers resolved_link and maps file references', async () => {
    const { buildItemPayload } = await import('../src/studyos.js');
    const p = buildItemPayload(
      {
        ...notification,
        type: 'documento',
        resolved_link: 'https://tecdigital.tec.ac.cr/item',
        files: [{ file_name: 'a.pdf', download_url: 'https://d/x', source_url: 's' }],
      },
      'name:otro curso',
    );
    expect(p.link).toBe('https://tecdigital.tec.ac.cr/item');
    expect(p.course.code).toBe('');
    expect(p.files).toEqual([{ file_name: 'a.pdf', download_url: 'https://d/x', mime_type: '' }]);
  });
});

describe('forwardNotification()', () => {
  it('posts the item and marks delivery', async () => {
    db.getNotificationId.mockResolvedValue('row-1');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const { forwardNotification } = await import('../src/studyos.js');
    await forwardNotification(baseUser, notification);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://study.alpizar.dev/api/sync/items');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body).external_id).toBe('notif_1');
    expect(db.markStudyosDelivered).toHaveBeenCalledWith('row-1');
    expect(db.recordStudyosFailure).not.toHaveBeenCalled();
  });

  it('records failure without throwing when StudyOS is down', async () => {
    db.getNotificationId.mockResolvedValue('row-1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const { forwardNotification } = await import('../src/studyos.js');
    await expect(forwardNotification(baseUser, notification)).resolves.toBeUndefined();
    expect(db.recordStudyosFailure).toHaveBeenCalledWith('row-1', expect.stringContaining('ECONNREFUSED'));
    expect(db.markStudyosDelivered).not.toHaveBeenCalled();
  });

  it('is a no-op when the user has no StudyOS target', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { forwardNotification } = await import('../src/studyos.js');
    await forwardNotification({ ...baseUser, studyos_url: null }, notification);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('retryStudyosPending()', () => {
  it('re-sends pending stored notifications and marks them', async () => {
    db.getPendingStudyosNotifications.mockResolvedValue([
      {
        id: 'row-9',
        external_id: 'notif_9',
        type: 'noticia',
        course: 'EL2207',
        title: 'Noticia',
        description: 'cuerpo',
        link: 'https://tec/x',
        published_at: '2026-07-13',
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const { retryStudyosPending } = await import('../src/studyos.js');
    await retryStudyosPending(baseUser);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.external_id).toBe('notif_9');
    expect(payload.published_at).toBe('2026-07-13');
    expect(db.markStudyosDelivered).toHaveBeenCalledWith('row-9');
  });
});
