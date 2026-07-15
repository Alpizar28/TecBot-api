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
} from '@tec-brain/database';
import type { User, RawNotification, FileReference } from '@tec-brain/types';
import { logger } from './logger.js';

const REQUEST_TIMEOUT_MS = 30_000;

export interface StudyosTarget {
  url: string;
  token: string;
}

export interface StudyosItemPayload {
  schema_version: 1;
  external_id: string;
  type: string;
  course: { key: string; code: string; name: string };
  title: string;
  body: string;
  link: string;
  published_at: string;
  detected_at: string;
  files: Array<{ file_name: string; download_url: string; mime_type: string }>;
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
    log.warn({ errorMessage: message }, 'StudyOS forward failed; will retry next cycle');
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
