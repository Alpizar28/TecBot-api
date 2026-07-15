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
      community_key: 'S-1-2026.CA.MA2104.1',
    });
    expect(payload.link).toBe(`${course.url}evaluation/tda-ce-estudiante/tda-index`);
    expect(payload.evaluation?.due_date).toBe('2026-03-20');
    expect(payload.evaluation?.grade_over_100).toBe(100.0);
    expect(payload.body).toContain('Fecha de entrega: 2026-03-20 08:00');
    expect(payload.body).toContain('Nota: 100/100');
  });
});

describe('currentEvalSlot()', () => {
  // Default schedule 7,12,17 in America/Costa_Rica (UTC-6).
  it('maps a time after a slot hour to that slot of the same day', async () => {
    const { currentEvalSlot } = await studyos();
    // 13:30 UTC = 07:30 CR
    expect(currentEvalSlot(new Date('2026-07-15T13:30:00Z'))).toBe('2026-07-15@7');
    // 18:05 UTC = 12:05 CR
    expect(currentEvalSlot(new Date('2026-07-15T18:05:00Z'))).toBe('2026-07-15@12');
    // 23:59 UTC = 17:59 CR
    expect(currentEvalSlot(new Date('2026-07-15T23:59:00Z'))).toBe('2026-07-15@17');
  });

  it("maps times before the first slot to yesterday's last slot", async () => {
    const { currentEvalSlot } = await studyos();
    // 10:00 UTC = 04:00 CR — before 07:00, belongs to yesterday@17
    expect(currentEvalSlot(new Date('2026-07-15T10:00:00Z'))).toBe('2026-07-14@17');
    // 05:00 UTC Jul 15 = 23:00 CR Jul 14 — after 17:00 of Jul 14
    expect(currentEvalSlot(new Date('2026-07-15T05:00:00Z'))).toBe('2026-07-14@17');
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

  it('runs once per schedule slot per user', async () => {
    stubFetch();
    const scrape = vi.fn().mockResolvedValue([course]);

    const { syncEvaluations } = await studyos();
    await syncEvaluations(user, scrape, { username: 'u', password: 'p' });
    await syncEvaluations(user, scrape, { username: 'u', password: 'p' });

    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it('clears the slot when the whole sweep fails so the next cycle retries', async () => {
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

describe('forwardStudyosAlerts()', () => {
  const alertsPayload = {
    alerts: [
      { id: 1, kind: 'due_48h', payload: { external_id: 'eval_1', title: 'Q4',
        course_id: 'ma2104', due_date: '2026-08-02' } },
      { id: 2, kind: 'graded', payload: { external_id: 'eval_2', title: 'Parcial 2',
        course_id: 'el2114', grade: '27.3/33.0 pts' } },
    ],
  };

  it('sends each alert via Telegram and acks the delivered ones', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/sync/alerts/ack')) {
        return new Response('{"acked":2}', { status: 200 });
      }
      return new Response(JSON.stringify(alertsPayload), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sent: string[] = [];
    const { forwardStudyosAlerts } = await studyos();
    await forwardStudyosAlerts(user, async (html) => { sent.push(html); });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Entrega en menos de 48 h');
    expect(sent[0]).toContain('MA2104');
    expect(sent[1]).toContain('Nota publicada');
    expect(sent[1]).toContain('27.3/33.0 pts');
    expect(sent[1]).toContain('hoy?item=eval_2');

    const ackCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/ack'));
    expect(ackCall).toBeTruthy();
    expect(JSON.parse(String((ackCall![1] as RequestInit).body))).toEqual({ ids: [1, 2] });
  });

  it('acks only the alerts that were actually sent', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/ack')) return new Response('{"acked":1}', { status: 200 });
      return new Response(JSON.stringify(alertsPayload), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let calls = 0;
    const { forwardStudyosAlerts } = await studyos();
    await forwardStudyosAlerts(user, async () => {
      calls += 1;
      if (calls === 1) throw new Error('telegram down');
    });

    const ackCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/ack'));
    expect(JSON.parse(String((ackCall![1] as RequestInit).body))).toEqual({ ids: [2] });
  });

  it('does nothing without StudyOS config', async () => {
    const fetchMock = stubFetch();
    const { forwardStudyosAlerts } = await studyos();
    await forwardStudyosAlerts({ ...user, studyos_url: null }, async () => {
      throw new Error('should not send');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
