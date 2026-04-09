import crypto from 'crypto';
import axios from 'axios';
import {
  getNotificationState,
  insertNotification,
  updateNotificationDocumentStatus,
  uploadedFileExists,
  insertUploadedFile,
  upsertCourseMapping,
  getCourseMapping,
  isAnyCourseMuted,
  resolveCourseEntry,
} from '@tec-brain/database';
import { TelegramService } from '@tec-brain/telegram';
import { DriveService } from '@tec-brain/drive';
import type { User, RawNotification } from '@tec-brain/types';
import { logger } from './logger.js';

interface LoggerLike {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface DispatchResult {
  processed: boolean;
  reason: string;
}

/** Regex to detect a bare course code like "FI2207" */
const COURSE_CODE_RE = /^[A-Z]{2,4}\d{3,4}$/i;
const DRIVE_AUTH_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const driveAlertTimestamps = new Map<string, number>();

/**
 * Resolves the best available course name for folder creation:
 * - If `course` is already a full name, save the code→name pair (if we also
 *   know the code from the link) and return the full name.
 * - If `course` is only a short code, try the DB cache; return cached name or
 *   fall back to the code itself.
 */
async function resolveCourseNameForDrive(course: string, link?: string): Promise<string> {
  const isCode = COURSE_CODE_RE.test(course.trim());

  if (!isCode) {
    // We have a full name — try to learn the code from the URL and persist it.
    if (link) {
      const codeMatch = link.match(/\/dotlrn\/classes\/(?:[^/]+\/)?([A-Z]{2,4}\d{3,4})(?:\/|$)/i);
      if (codeMatch?.[1]) {
        await upsertCourseMapping(codeMatch[1], course).catch(() => {
          /* non-critical — never fail dispatch because of this */
        });
      }
    }
    return course;
  }

  // We only have a code — check the global cache.
  const cached = await getCourseMapping(course).catch(() => null);
  return cached ?? course;
}

export async function dispatch(
  user: User,
  notification: RawNotification,
  scraperUrl: string,
  tecPassword: string,
  telegram: TelegramService,
  drive: DriveService | null,
): Promise<DispatchResult> {
  const log = logger.child({
    component: 'dispatcher',
    userId: user.id,
    externalId: notification.external_id,
    type: notification.type,
  });

  const { exists, document_status: previousStatus } = await getNotificationState(
    user.id,
    notification.external_id,
  );
  const resolvedCourse = await resolveCourseEntry(notification.course);
  const courseKeys = [resolvedCourse.key, resolvedCourse.legacyKey].filter(
    (key, index, arr) => key && arr.indexOf(key) === index,
  );
  const muted = await isAnyCourseMuted(user.id, courseKeys);
  const isDocument = notification.type === 'documento';
  const resolvedNow = notification.document_status === 'resolved' && !!notification.files?.length;
  let hasPendingUploads = false;

  if (muted) {
    log.info(
      { courseKey: resolvedCourse.key, course: notification.course },
      'Notification muted by user filter',
    );
    if (!exists) {
      await insertNotification(user.id, notification);
    }
    return { processed: true, reason: 'muted' };
  }

  if (exists && isDocument && notification.files && notification.files.length > 0) {
    for (const file of notification.files) {
      const fileHash = crypto
        .createHash('sha256')
        .update(file.download_url + file.file_name)
        .digest('hex');
      if (!(await uploadedFileExists(user.id, fileHash))) {
        hasPendingUploads = true;
        break;
      }
    }
  }

  const shouldRetryDocument =
    exists && isDocument && resolvedNow && (previousStatus !== 'resolved' || hasPendingUploads);

  if (exists && !shouldRetryDocument) {
    log.info({ previousStatus }, 'Duplicate notification already handled');
    return { processed: true, reason: 'duplicate' };
  }

  if (shouldRetryDocument) {
    log.info(
      { previousStatus, hasPendingUploads },
      'Retrying previously unresolved/partial document notification',
    );
  }

  let processed = true;

  try {
    switch (notification.type) {
      case 'noticia': {
        processed = await safeTelegram(
          user,
          notification,
          () => telegram.sendNotice(user, notification),
          'telegram_notice',
        );
        break;
      }

      case 'evaluacion': {
        processed = await safeTelegram(
          user,
          notification,
          () => telegram.sendEvaluation(user, notification),
          'telegram_eval',
        );
        break;
      }

      case 'documento': {
        processed = await handleDocumentNotification(
          user,
          notification,
          scraperUrl,
          tecPassword,
          telegram,
          drive,
          log,
        );
        break;
      }
    }
  } catch (error) {
    processed = false;
    logStructuredError(user, notification, 'dispatch_internal', error);
  }

  if (processed || exists) {
    if (!exists) {
      log.info('Marking new notification as seen');
      await insertNotification(user.id, notification);
    } else if (shouldRetryDocument && notification.document_status === 'resolved') {
      log.info('Updating existing document notification status to resolved');
      await updateNotificationDocumentStatus(user.id, notification.external_id, 'resolved');
    }
  } else {
    log.warn(
      'Notification had partial/failed processing and was not previously seen; skipping persistence to allow retry',
    );
  }

  return {
    processed,
    reason: processed ? 'processed' : 'partial_or_failed',
  };
}

async function handleDocumentNotification(
  user: User,
  notification: RawNotification,
  scraperUrl: string,
  tecPassword: string,
  telegram: TelegramService,
  drive: DriveService | null,
  log: LoggerLike,
): Promise<boolean> {
  if (drive && user.drive_root_folder_id && notification.files && notification.files.length > 0) {
    const resolvedCourse = await resolveCourseNameForDrive(notification.course, notification.link);
    const courseFolderId = await drive.ensureFolder(resolvedCourse, user.drive_root_folder_id);

    const results = await Promise.all(
      notification.files.map(async (file) => {
        try {
          const fileHash = crypto
            .createHash('sha256')
            .update(file.download_url + file.file_name)
            .digest('hex');

          if (await uploadedFileExists(user.id, fileHash)) {
            log.info({ fileName: file.file_name }, 'Skipping duplicate document upload');
            return true;
          }

          log.info(
            { fileName: file.file_name, downloadUrl: file.download_url },
            'Attempting Drive upload',
          );

          // Downloader: proxy the download through the scraper so the active
          // CookieJar session is used instead of raw exported cookies.
          const downloader = async () => {
            const res = await axios.post<ArrayBuffer>(
              `${scraperUrl}/download-file`,
              {
                username: user.tec_username,
                password: tecPassword,
                downloadUrl: file.download_url,
              },
              { responseType: 'arraybuffer', timeout: 60_000 },
            );
            const contentType =
              (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
            return { data: res.data, contentType };
          };

          const { fileId } = await drive.downloadAndUpload(
            downloader,
            file.file_name,
            courseFolderId,
          );

          await insertUploadedFile(user.id, resolvedCourse, fileHash, file.file_name, fileId);
          const notified = await safeTelegram(
            user,
            notification,
            () => telegram.sendDocumentSaved(user, notification, file.file_name, fileId),
            'telegram_doc_saved',
          );
          return notified;
        } catch (error) {
          logStructuredError(user, notification, 'drive_upload', error);
          if (isDriveAuthError(error)) {
            await maybeNotifyDriveAuthExpiration(user, telegram, log);
          }
          const notified = await safeTelegram(
            user,
            notification,
            () =>
              telegram.sendDocumentDownload(user, notification, file.file_name, file.download_url),
            'telegram_doc_fallback',
          );
          if (notified) {
            // Mark file as processed via fallback so it is not retried next cycle.
            // Without this, hasPendingUploads stays true and the notification is
            // re-dispatched every cycle, sending duplicate Telegram messages.
            const fileHash = crypto
              .createHash('sha256')
              .update(file.download_url + file.file_name)
              .digest('hex');
            await insertUploadedFile(user.id, resolvedCourse, fileHash, file.file_name, 'fallback');
            log.info(
              { fileName: file.file_name },
              'Marked document as fallback-sent to prevent duplicate retries',
            );
          }
          return notified;
        }
      }),
    );

    return results.every(Boolean);
  }

  if (notification.files && notification.files.length > 0) {
    const results = await Promise.all(
      notification.files.map(async (file) => {
        const sent = await safeTelegram(
          user,
          notification,
          () =>
            telegram.sendDocumentDownload(user, notification, file.file_name, file.download_url),
          'telegram_doc_download',
        );

        if (sent) {
          const fileHash = crypto
            .createHash('sha256')
            .update(file.download_url + file.file_name)
            .digest('hex');
          await insertUploadedFile(
            user.id,
            notification.course,
            fileHash,
            file.file_name,
            'fallback',
          );
        }

        return sent;
      }),
    );
    return results.every(Boolean);
  }

  return safeTelegram(
    user,
    notification,
    () => telegram.sendDocumentLink(user, notification),
    'telegram_doc_link',
  );
}

function isDriveAuthError(err: unknown): boolean {
  if (!err) return false;

  const message = err instanceof Error ? err.message.toLowerCase() : '';
  if (message.includes('invalid_grant') || message.includes('needs_browser')) {
    return true;
  }

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      const data = err.response?.data as { error?: string; error_description?: string } | undefined;
      const dataMsg = `${data?.error ?? ''} ${data?.error_description ?? ''}`.toLowerCase();
      if (dataMsg.includes('invalid_grant') || dataMsg.includes('unauthorized')) {
        return true;
      }
    }
  }

  const errors = (err as { errors?: Array<{ reason?: string }> })?.errors;
  if (Array.isArray(errors)) {
    return errors.some(
      (item) =>
        (item.reason ?? '').toLowerCase().includes('auth') ||
        (item.reason ?? '').toLowerCase().includes('forbidden'),
    );
  }

  return false;
}

async function maybeNotifyDriveAuthExpiration(
  user: User,
  telegram: TelegramService,
  log: LoggerLike,
): Promise<void> {
  const lastAlert = driveAlertTimestamps.get(user.id) ?? 0;
  const now = Date.now();
  if (now - lastAlert < DRIVE_AUTH_ALERT_COOLDOWN_MS) {
    log.info({ userId: user.id }, 'Drive auth alert skipped due to cooldown');
    return;
  }

  try {
    await telegram.sendDriveAuthExpired(user);
    driveAlertTimestamps.set(user.id, now);
    log.warn({ userId: user.id }, 'Drive authorization expired. Renewal reminder sent');
  } catch (error) {
    logger.warn(
      {
        component: 'dispatcher',
        userId: user.id,
        action: 'drive_auth_alert',
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      'Failed to send Drive auth renewal reminder',
    );
  }
}

function logStructuredError(
  user: User,
  notif: RawNotification,
  action: string,
  err: unknown,
): void {
  const errorMsg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axiosErr = axios.isAxiosError(err) ? (err as any) : null;
  const axiosDetails = axiosErr
    ? {
        status: axiosErr.response?.status,
        statusText: axiosErr.response?.statusText,
        url: axiosErr.config?.url,
        responseData: JSON.stringify(axiosErr.response?.data)?.slice(0, 500),
      }
    : undefined;
  logger.error(
    {
      component: 'dispatcher',
      userId: user.id,
      externalId: notif.external_id,
      type: notif.type,
      action,
      errorMessage: errorMsg,
      ...(axiosDetails ? { axiosDetails } : {}),
    },
    'Dispatch action failed',
  );
}

async function safeTelegram(
  user: User,
  notif: RawNotification,
  fn: () => Promise<void>,
  action: string,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    logStructuredError(user, notif, action, error);
    return false;
  }
}
