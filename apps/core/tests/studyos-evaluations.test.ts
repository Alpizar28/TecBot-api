import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@tec-brain/types';

const db = {
  decrypt: vi.fn((v: string) => v.replace('enc:', '')),
  getNotificationId: vi.fn(),
  markStudyosDelivered: vi.fn().mockResolvedValue(undefined),
  recordStudyosFailure: vi.fn().mockResolvedValue(undefined),
  getPendingStudyosNotifications: vi.fn().mockResolvedValue([]),
  resolveCourseEntry: vi.fn(),
};

vi.mock('@tec-brain/database', () => db);

async function studyos() {
  return import('../src/studyos.js');
}

const user: User = {
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

const course = {
  code: 'MA2104',
  community_key: 'S-1-2026.CA.MA2104.1',
  name: 'Cálculo superior GR 1',
  url: 'https://tecdigital.tec.ac.cr/dotlrn/classes/MA/MA2104/S-1-2026.CA.MA2104.1/',
  evaluations: [
    {
      external_id: 'eval_abc123',
      category: 'Quices o Tareas',
      category_weight: 20,
      title: 'Q2',
      score: null,
      max_score: null,
      weighted_score: 100.0,
      grade_over_100: 100.0,
      description: 'Ver capítulo 4',
      due_date: '2026-03-20',
      due_time: '08:00',
      late_allowed: true,
      comments: 'Puntos extra',
      files: [
        {
          file_name: 'Quiz2Tarea1.pdf',
          download_url:
            'https://tecdigital.tec.ac.cr/dotlrn/classes/MA/MA2104/S-1-2026.CA.MA2104.1/evaluation/view/Quiz2Tarea1.pdf?revision_id=1',
          mime_type: 'application/pdf',
        },
      ],
    },
  ],
};

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  vi.clearAllMocks();
  (await studyos()).resetEvaluationSyncThrottle();
  db.decrypt.mockImplementation((v: string) => v.replace('enc:', ''));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue(new Response('{"status":"created"}', { status: 200 }));
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('buildEvaluationItemPayload()', () => {
  it('maps rubric data to the sync contract with the evaluation block', async () => {
    const { buildEvaluationItemPayload } = await studyos();
    const payload = buildEvaluationItemPayload(course, course.evaluations[0], '2026-07-15T00:00:00Z');
    expect(payload.type).toBe('evaluacion');
    expect(payload.external_id).toBe('eval_abc123');
    expect(payload.course).toEqual({
      key: 'code:MA2104',
      code: 'MA2104',
      name: 'Cálculo superior GR 1',
    });
    expect(payload.link).toBe(`${course.url}evaluation/tda-ce-estudiante/tda-index`);
    expect(payload.evaluation?.due_date).toBe('2026-03-20');
    expect(payload.evaluation?.grade_over_100).toBe(100.0);
    expect(payload.body).toContain('Fecha de entrega: 2026-03-20 08:00');
    expect(payload.body).toContain('Nota: 100/100');
  });
});

describe('syncEvaluations()', () => {
  it('posts every evaluation item and its statement files', async () => {
    const fetchMock = stubFetch();
    const downloader = vi
      .fn()
      .mockResolvedValue({ data: new ArrayBuffer(4), contentType: 'application/pdf' });

    const { syncEvaluations } = await studyos();
    await syncEvaluations(
      user,
      async () => [course],
      { username: user.tec_username, password: 'pwd' },
      downloader,
    );

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://study.alpizar.dev/api/sync/items');
    expect(urls).toContain('https://study.alpizar.dev/api/sync/files');
    expect(downloader).toHaveBeenCalledWith(course.evaluations[0].files[0].download_url);
  });

  it('is throttled per user within the sync interval', async () => {
    stubFetch();
    const scrape = vi.fn().mockResolvedValue([course]);

    const { syncEvaluations } = await studyos();
    await syncEvaluations(user, scrape, { username: 'u', password: 'p' });
    await syncEvaluations(user, scrape, { username: 'u', password: 'p' });

    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it('clears the throttle when the whole sweep fails so the next cycle retries', async () => {
    stubFetch();
    const scrape = vi.fn().mockRejectedValue(new Error('scraper down'));

    const { syncEvaluations } = await studyos();
    await syncEvaluations(user, scrape, { username: 'u', password: 'p' });
    await syncEvaluations(user, scrape, { username: 'u', password: 'p' });

    expect(scrape).toHaveBeenCalledTimes(2);
  });

  it('does nothing for users without StudyOS config', async () => {
    const fetchMock = stubFetch();
    const scrape = vi.fn();

    const { syncEvaluations } = await studyos();
    await syncEvaluations(
      { ...user, studyos_url: null },
      scrape,
      { username: 'u', password: 'p' },
    );

    expect(scrape).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
