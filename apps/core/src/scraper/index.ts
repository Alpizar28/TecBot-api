/**
 * Scraper module — wrapped as an internal Core dependency.
 *
 * Provides TEC Digital scraping (notifications, evaluations, file downloads)
 * using persistent CookieJar sessions on disk, without an HTTP sidecar.
 */
import { TecHttpClient } from './tec-http.client.js';
import { SessionManager } from './session-manager.js';
import { processNotificationsSequentially as processNotifs } from './notifications.js';
import { scrapeEvaluations as scrapeEvals } from './evaluations.js';
import type { RawNotification } from '@tec-brain/types';
import { logger } from '../logger.js';

const SESSION_DIR = process.env.SESSION_DIR ?? './data/sessions';
const sessionManager = new SessionManager(SESSION_DIR, logger);

// ─── Re-export types so callers can use them ────────────────────────────────

export type {
  CourseRef,
  EvaluationFile,
  CourseEvaluation,
  CourseEvaluations,
  CourseSelection,
} from './evaluations.js';

export {
  ensureAbsoluteUrl,
  extractCourse,
  classifyType,
  buildExternalId,
} from './notifications.js';

// ─── High-level public API ──────────────────────────────────────────────────

/**
 * Fetch and dispatch all unread TEC notifications for a user.
 *
 * Internally manages the TEC session (login, retry on invalid session).
 * Each notification is passed to `onNotification` as it is processed.
 */
export async function processUserNotifications(
  username: string,
  password: string,
  userId: string,
  onNotification: (
    notification: RawNotification,
  ) => Promise<{ processed: boolean; reason: string }>,
  keywords: string[] = [],
  courseId = '',
): Promise<'ok' | 'error'> {
  const client = await safeGetClient(username, password);
  if (!client) return 'error';

  const initialStatus = await processNotifs(client, userId, onNotification, keywords, courseId);

  if (initialStatus === 'invalid_session') {
    logger.warn({ userId }, 'Invalid session detected, re-authenticating');
    client.jar.removeAllCookiesSync();
    try {
      await sessionManager.login(client, username, password);
    } catch {
      logger.error({ userId }, 'Session invalid after re-authentication');
      return 'error';
    }

    const retryStatus = await processNotifs(client, userId, onNotification, keywords, courseId);
    if (retryStatus === 'invalid_session') {
      logger.error({ userId }, 'Session invalid after re-authentication');
      return 'error';
    }
  }

  return 'ok';
}

/**
 * Scrape all current-term course evaluations for a user.
 */
export async function getUserEvaluations(
  username: string,
  password: string,
  shouldScrapeCourse?: import('./evaluations.js').CourseSelection,
): Promise<import('./evaluations.js').CourseEvaluations[]> {
  const client = await safeGetClient(username, password);
  if (!client) return [];

  let courses = await scrapeEvals(client, shouldScrapeCourse);

  if (courses.length === 0) {
    logger.warn({ username }, 'No courses found, re-authenticating');
    client.jar.removeAllCookiesSync();
    try {
      await sessionManager.login(client, username, password);
    } catch {
      logger.error({ username }, 'Re-authentication failed for evaluations');
      return courses;
    }
    courses = await scrapeEvals(client, shouldScrapeCourse);
  }

  return courses;
}

/**
 * Download a file from TEC Digital using the user's session.
 */
export async function downloadTecFile(
  username: string,
  password: string,
  downloadUrl: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const client = await safeGetClient(username, password);
  if (!client) return null;

  const response = await client.client.get<ArrayBuffer>(downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    maxRedirects: 5,
  });

  const contentType =
    (response.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
  return { data: response.data, contentType };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

async function safeGetClient(username: string, password: string): Promise<TecHttpClient | null> {
  try {
    return await sessionManager.getClient(username, password);
  } catch (error) {
    logger.error(
      { username, error: error instanceof Error ? error.message : String(error) },
      'Failed to create TEC HTTP client',
    );
    return null;
  }
}
