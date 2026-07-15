/**
 * StudyOS forwarding: third dispatch destination (after Telegram and storage).
 *
 * Contract (schema_version 1): POST {studyos_url}/api/sync/items with a
 * bearer token, idempotent by external_id on the StudyOS side. Binaries go
 * to POST /api/sync/files as multipart. Delivery state is tracked per
 * notification in the studyos_dispatch table and retried by the cron cycle
 * (retryStudyosPending) — no extra broker.
 */
import {
  decrypt,
  getNotificationId,
  getPendingStudyosNotifications,
  markStudyosDelivered,
  recordStudyosFailure,
  resolveCourseEntry,
  insertErrorLog,
} from '@tec-brain/database';
import type { User, RawNotification, FileReference } from '@tec-brain/types';
import { logger } from './logger.js';

const REQUEST_TIMEOUT_MS = 30_000;

export interface StudyosTarget {
  url: string;
  token: string;
}

export interface StudyosEvaluationMeta {
  category: string;
  category_weight: number | null;
  weight: number | null;
  score: number | null;
  max_score: number | null;
  weighted_score: number | null;
  grade_over_100: number | null;
  due_date: string;
  due_time: string;
  late_allowed: boolean;
}

export interface StudyosItemPayload {
  schema_version: 1;
  external_id: string;
  type: string;
  /** community_key (e.g. "S-2-2026.CA.EL2114.2") lets StudyOS know the term */
  course: { key: string; code: string; name: string; community_key?: string };
  title: string;
  body: string;
  link: string;
  published_at: string;
  detected_at: string;
  files: Array<{ file_name: string; download_url: string; mime_type: string }>;
  /** Structured rubric data — only present on items scraped from Evaluaciones */
  evaluation?: StudyosEvaluationMeta;
}

export function getStudyosTarget(user: User): StudyosTarget | null {
  if (!user.studyos_url || !user.studyos_token_enc) return null;
  try {
    return { url: user.studyos_url.replace(/\/+$/, ''), token: decrypt(user.studyos_token_enc) };
  } catch (err) {
    logger.warn(
      {
        component: 'studyos',
        userId: user.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      'Failed to decrypt StudyOS token — forwarding skipped',
    );
    return null;
  }
}

interface ItemSource {
  external_id: string;
  type: string;
  course: string;
  title: string;
  description?: string | null;
  link?: string | null;
  resolved_link?: string | null;
  date?: string | null;
  published_at?: string | null;
  files?: FileReference[];
}

export function buildItemPayload(
  n: ItemSource,
  courseKey: string,
  detectedAt = new Date().toISOString(),
): StudyosItemPayload {
  const code = courseKey.startsWith('code:') ? courseKey.slice(5).toUpperCase() : '';
  return {
    schema_version: 1,
    external_id: n.external_id,
    type: n.type,
    course: { key: courseKey, code, name: n.course },
    title: n.title || '',
    body: n.description ?? '',
    link: n.resolved_link ?? n.link ?? '',
    published_at: n.published_at ?? n.date ?? '',
    detected_at: detectedAt,
    files: (n.files ?? []).map((f) => ({
      file_name: f.file_name,
      download_url: f.download_url,
      mime_type: f.mime_type ?? '',
    })),
  };
}

async function studyosFetch(
  target: StudyosTarget,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(`${target.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${target.token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`StudyOS ${path} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

export async function postItem(target: StudyosTarget, payload: StudyosItemPayload): Promise<void> {
  await studyosFetch(target, '/api/sync/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function postFile(
  target: StudyosTarget,
  externalId: string,
  file: { file_name: string; mime_type?: string; source_url?: string },
  data: ArrayBuffer,
): Promise<void> {
  const form = new FormData();
  form.append(
    'meta',
    JSON.stringify({
      external_id: externalId,
      file_name: file.file_name,
      mime_type: file.mime_type || 'application/pdf',
      source_url: file.source_url ?? '',
    }),
  );
  form.append('file', new Blob([data], { type: file.mime_type || 'application/pdf' }), file.file_name);
  await studyosFetch(target, '/api/sync/files', { method: 'POST', body: form });
}

export type FileDownloader = (
  downloadUrl: string,
) => Promise<{ data: ArrayBuffer; contentType: string }>;

/**
 * Forwards one notification (and its binaries, when a downloader is given)
 * to the user's StudyOS instance, recording delivery state. Never throws:
 * failures are recorded in studyos_dispatch and retried next cycle.
 */
export async function forwardNotification(
  user: User,
  notification: RawNotification,
  downloader?: FileDownloader,
): Promise<void> {
  const target = getStudyosTarget(user);
  if (!target) return;

  const log = logger.child({
    component: 'studyos',
    userId: user.id,
    externalId: notification.external_id,
  });

  const notificationId = await getNotificationId(user.id, notification.external_id).catch(
    () => null,
  );
  if (!notificationId) {
    // Not persisted (partial processing) — the whole notification will be
    // re-dispatched next cycle, forward will run again then.
    log.info('Notification not persisted yet; skipping StudyOS forward');
    return;
  }

  try {
    const resolved = await resolveCourseEntry(notification.course);
    await postItem(target, buildItemPayload(notification, resolved.key));

    if (downloader && notification.files?.length) {
      for (const file of notification.files) {
        try {
          const { data, contentType } = await downloader(file.download_url);
          await postFile(
            target,
            notification.external_id,
            {
              file_name: file.file_name,
              mime_type: file.mime_type || contentType,
              source_url: file.source_url,
            },
            data,
          );
        } catch (err) {
          // File forward is best-effort: the item itself was delivered; the
          // document retry path (shouldRetryDocument) re-runs with fresh files.
          log.warn(
            {
              fileName: file.file_name,
              errorMessage: err instanceof Error ? err.message : String(err),
            },
            'StudyOS file forward failed',
          );
        }
      }
    }

    await markStudyosDelivered(notificationId);
    log.info('Forwarded to StudyOS');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordStudyosFailure(notificationId, message).catch(() => {});
    void insertErrorLog({
      user_id: user.id,
      external_id: notification.external_id,
      notif_type: notification.type,
      action: 'studyos_forward',
      error_message: message,
    }).catch(() => {});
    log.warn({ errorMessage: message }, 'StudyOS forward failed; will retry next cycle');
  }
}

// ─── Evaluations sync (rubric scrape → StudyOS) ──────────────────────────────

interface ScrapedEvaluationCourse {
  code: string;
  community_key: string;
  name: string;
  url: string;
  evaluations: Array<{
    external_id: string;
    category: string;
    category_weight: number | null;
    title: string;
    score: number | null;
    max_score: number | null;
    weighted_score: number | null;
    grade_over_100: number | null;
    description: string;
    due_date: string;
    due_time: string;
    late_allowed: boolean;
    comments: string;
    files: Array<{ file_name: string; download_url: string; mime_type: string }>;
  }>;
}

// Sweep schedule: once after each configured hour (default 07/12/17 in
// America/Costa_Rica) instead of a fixed interval — the rubric changes a few
// times a week at most, three sweeps a day is plenty.
const EVAL_SYNC_HOURS = (() => {
  const hours = [
    ...new Set(
      (process.env.STUDYOS_EVAL_SYNC_HOURS ?? '7,12,17')
        .split(',')
        .map((h) => parseInt(h.trim(), 10))
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),
    ),
  ].sort((a, b) => a - b);
  return hours.length > 0 ? hours : [7, 12, 17];
})();
const EVAL_SYNC_TZ = process.env.STUDYOS_EVAL_SYNC_TZ ?? 'America/Costa_Rica';

/**
 * "YYYY-MM-DD@HH" of the most recent schedule slot at `now` (in EVAL_SYNC_TZ).
 * Before the first slot of the day it returns yesterday's last slot, so a
 * fresh process always has one slot "due". Exported for tests.
 */
export function currentEvalSlot(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVAL_SYNC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const read = (d: Date) => {
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: parseInt(parts.hour, 10) % 24, // some ICU builds emit "24" at midnight
    };
  };
  const today = read(now);
  const slot = [...EVAL_SYNC_HOURS].reverse().find((h) => h <= today.hour);
  if (slot !== undefined) return `${today.date}@${slot}`;
  const yesterday = read(new Date(now.getTime() - 86_400_000));
  return `${yesterday.date}@${EVAL_SYNC_HOURS[EVAL_SYNC_HOURS.length - 1]}`;
}

// Per-user slot key of the last evaluations sweep. In-memory on purpose:
// the sweep is stateless (StudyOS dedupes by external_id and detects content
// changes), so losing this on restart only costs one extra sweep.
const lastEvalSlot = new Map<string, string>();

export function buildEvaluationItemPayload(
  course: ScrapedEvaluationCourse,
  ev: ScrapedEvaluationCourse['evaluations'][number],
  detectedAt = new Date().toISOString(),
): StudyosItemPayload {
  const gradeLine =
    ev.grade_over_100 !== null
      ? `Nota: ${ev.grade_over_100}/100`
      : ev.score !== null && ev.max_score !== null
        ? `Nota: ${ev.score}/${ev.max_score} pts`
        : ev.weighted_score !== null
          ? `Nota ponderada: ${ev.weighted_score}`
          : '';
  const lines = [
    ev.description,
    ev.due_date ? `Fecha de entrega: ${ev.due_date}${ev.due_time ? ` ${ev.due_time}` : ''}` : '',
    gradeLine,
    ev.comments ? `Comentarios: ${ev.comments}` : '',
    ev.max_score !== null ? `Valor: ${ev.max_score} pts de ${ev.category} (${ev.category_weight ?? '?'}%)` : `Categoría: ${ev.category}`,
  ].filter(Boolean);

  return {
    schema_version: 1,
    external_id: ev.external_id,
    type: 'evaluacion',
    course: {
      key: `code:${course.code}`,
      code: course.code,
      name: course.name,
      community_key: course.community_key,
    },
    title: ev.title,
    body: lines.join('\n'),
    link: `${course.url}evaluation/tda-ce-estudiante/tda-index`,
    published_at: '',
    detected_at: detectedAt,
    files: ev.files,
    evaluation: {
      category: ev.category,
      category_weight: ev.category_weight,
      weight: ev.max_score,
      score: ev.score,
      max_score: ev.max_score,
      weighted_score: ev.weighted_score,
      grade_over_100: ev.grade_over_100,
      due_date: ev.due_date,
      due_time: ev.due_time,
      late_allowed: ev.late_allowed,
    },
  };
}

export interface EvaluationScraper {
  (username: string, password: string): Promise<ScrapedEvaluationCourse[]>;
}

/**
 * Scrapes the per-course Evaluaciones rubric and forwards every assignment
 * to the user's StudyOS. Runs once per schedule slot per user
 * (STUDYOS_EVAL_SYNC_HOURS, default "7,12,17" in STUDYOS_EVAL_SYNC_TZ,
 * default America/Costa_Rica): the cron cycle calls this every few minutes
 * and it no-ops until the next slot boundary passes.
 * Stateless: every sweep re-posts everything; StudyOS answers duplicate for
 * unchanged items and updated when a grade/due date appears. Never throws.
 */
export async function syncEvaluations(
  user: User,
  scrape: EvaluationScraper,
  credentials: { username: string; password: string },
  downloader?: FileDownloader,
): Promise<void> {
  const target = getStudyosTarget(user);
  if (!target) return;

  const slot = currentEvalSlot();
  if (lastEvalSlot.get(user.id) === slot) return;
  lastEvalSlot.set(user.id, slot);

  const log = logger.child({ component: 'studyos_evaluations', userId: user.id });

  try {
    const courses = await scrape(credentials.username, credentials.password);
    let sent = 0;
    let failed = 0;

    for (const course of courses) {
      for (const ev of course.evaluations) {
        const payload = buildEvaluationItemPayload(course, ev);
        try {
          await postItem(target, payload);
          sent += 1;

          if (downloader && ev.files.length > 0) {
            for (const file of ev.files) {
              try {
                const { data, contentType } = await downloader(file.download_url);
                await postFile(
                  target,
                  ev.external_id,
                  {
                    file_name: file.file_name,
                    mime_type: file.mime_type || contentType,
                    source_url: file.download_url,
                  },
                  data,
                );
              } catch (err) {
                // Best-effort: the item was delivered; the next sweep retries.
                log.warn(
                  {
                    fileName: file.file_name,
                    errorMessage: err instanceof Error ? err.message : String(err),
                  },
                  'Evaluation file forward failed',
                );
              }
            }
          }
        } catch (err) {
          failed += 1;
          log.warn(
            {
              externalId: ev.external_id,
              errorMessage: err instanceof Error ? err.message : String(err),
            },
            'Evaluation item forward failed',
          );
        }
      }
    }

    log.info({ courses: courses.length, sent, failed }, 'Evaluations sweep finished');
  } catch (err) {
    // Full-sweep failure: clear the slot so the next cycle retries.
    lastEvalSlot.delete(user.id);
    log.warn(
      { errorMessage: err instanceof Error ? err.message : String(err) },
      'Evaluations sweep failed',
    );
  }
}

/** Test hook: resets the per-user evaluations schedule state. */
export function resetEvaluationSyncThrottle(): void {
  lastEvalSlot.clear();
}

// ─── StudyOS alert queue → Telegram ─────────────────────────────────────────

export interface StudyosAlert {
  id: number;
  kind: string;
  payload: {
    external_id?: string;
    title?: string;
    course_id?: string | null;
    due_date?: string;
    grade?: string;
    link?: string;
  };
}

const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatStudyosAlert(target: StudyosTarget, alert: StudyosAlert): string {
  const p = alert.payload ?? {};
  const title = escHtml(p.title || 'Evaluación');
  const course = p.course_id ? `<b>${escHtml(p.course_id.toUpperCase())}</b> · ` : '';
  const linkLine = p.external_id
    ? `\n🎓 <a href="${escHtml(`${target.url}/hoy?item=${encodeURIComponent(p.external_id)}`)}">Ver en StudyOS</a>`
    : '';
  if (alert.kind === 'graded') {
    const grade = p.grade ? `: <b>${escHtml(p.grade)}</b>` : '';
    return `📊 ${course}Nota publicada\n${title}${grade}${linkLine}`;
  }
  const when = alert.kind === 'due_24h' ? 'en menos de 24 h' : 'en menos de 48 h';
  const due = p.due_date ? ` — ${escHtml(p.due_date)}` : '';
  return `⏰ ${course}Entrega ${when}\n${title}${due}${linkLine}`;
}

/**
 * Drains the StudyOS alert queue (upcoming deadlines, freshly published
 * grades) and sends each as a Telegram message. Alerts are acked only after
 * a successful send, so failures retry next cycle. Never throws.
 */
export async function forwardStudyosAlerts(
  user: User,
  send: (html: string) => Promise<void>,
): Promise<void> {
  const target = getStudyosTarget(user);
  if (!target) return;
  const log = logger.child({ component: 'studyos_alerts', userId: user.id });

  try {
    const res = await studyosFetch(target, '/api/sync/alerts', { method: 'GET' });
    const { alerts } = (await res.json()) as { alerts: StudyosAlert[] };
    if (!alerts?.length) return;

    const acked: number[] = [];
    for (const alert of alerts) {
      try {
        await send(formatStudyosAlert(target, alert));
        acked.push(alert.id);
      } catch (err) {
        log.warn(
          {
            alertId: alert.id,
            kind: alert.kind,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          'StudyOS alert send failed',
        );
      }
    }
    if (acked.length > 0) {
      await studyosFetch(target, '/api/sync/alerts/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: acked }),
      });
    }
    log.info({ sent: acked.length, total: alerts.length }, 'StudyOS alerts forwarded');
  } catch (err) {
    log.warn(
      { errorMessage: err instanceof Error ? err.message : String(err) },
      'StudyOS alerts sweep failed',
    );
  }
}

/**
 * Retries undelivered notifications for a user (called once per cron cycle).
 * Retries send the item metadata only — binaries flow through the document
 * retry path, which re-resolves files from TEC Digital.
 */
export async function retryStudyosPending(user: User): Promise<void> {
  const target = getStudyosTarget(user);
  if (!target) return;

  const pending = await getPendingStudyosNotifications(user.id).catch(() => []);
  if (pending.length === 0) return;

  const log = logger.child({ component: 'studyos', userId: user.id });
  log.info({ count: pending.length }, 'Retrying pending StudyOS deliveries');

  for (const n of pending) {
    try {
      const resolved = await resolveCourseEntry(n.course);
      await postItem(target, buildItemPayload(n, resolved.key));
      await markStudyosDelivered(n.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordStudyosFailure(n.id, message).catch(() => {});
      log.warn(
        { externalId: n.external_id, errorMessage: message },
        'StudyOS retry failed',
      );
    }
  }
}
