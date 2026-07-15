import axios from 'axios';
import {
  getActiveUsers,
  getUserById,
  getDriveOAuthToken,
  getOneDriveOAuthToken,
  saveDriveOAuthToken,
  saveOneDriveOAuthToken,
  saveCycleStats,
  insertErrorLog,
  purgeOldErrors,
  encrypt,
  decrypt,
} from '@tec-brain/database';
import { TelegramService } from '@tec-brain/telegram';
import {
  DriveService,
  OneDriveService,
  loadOAuthClientConfig,
  loadOneDriveOAuthConfig,
  type OAuthClient,
  type OneDriveOAuthClient,
} from '@tec-brain/drive';
import { dispatch, recentDispatchErrors, type DispatchResult } from './dispatcher.js';
import {
  forwardStudyosAlerts,
  retryStudyosPending,
  syncEvaluations,
  type FileDownloader,
} from './studyos.js';
import pLimit from 'p-limit';
import type { ScrapeResponse } from '@tec-brain/types';
import { logger } from './logger.js';

const SCRAPER_URL = process.env.SCRAPER_URL ?? 'http://scraper:3001';
const HTTP_RETRY_ATTEMPTS = parseInt(process.env.HTTP_RETRY_ATTEMPTS ?? '3', 10);
const HTTP_RETRY_BASE_MS = parseInt(process.env.HTTP_RETRY_BASE_MS ?? '400', 10);
const ALERT_PARTIAL_THRESHOLD_PCT = parseInt(process.env.ALERT_PARTIAL_THRESHOLD_PCT ?? '20', 10);
const ALERT_USER_FAILURES_THRESHOLD = parseInt(
  process.env.ALERT_USER_FAILURES_THRESHOLD ?? '1',
  10,
);
const ADMIN_ALERT_CHAT_ID = process.env.ADMIN_ALERT_CHAT_ID ?? '';
// While a failure stays broken, remind at most this often (default 6 h);
// otherwise alerts fire only on state transitions (started failing / recovered).
const ADMIN_ALERT_REMIND_MS =
  parseInt(process.env.ADMIN_ALERT_COOLDOWN_MINUTES ?? '360', 10) * 60_000;

// key → last-sent ms; a key being present means that alert is currently firing.
const adminAlertTimestamps: Record<string, number> = {};

// Singleton Telegram service
const telegram = new TelegramService(process.env.TELEGRAM_BOT_TOKEN ?? '');

// Load OAuth client config once at startup (used to build per-user DriveService)
let oauthClient: OAuthClient | null = null;
if (process.env.GOOGLE_OAUTH_CLIENT_PATH) {
  try {
    oauthClient = loadOAuthClientConfig(process.env.GOOGLE_OAUTH_CLIENT_PATH);
    logger.info({ component: 'orchestrator' }, 'Google Drive OAuth client loaded');
  } catch (err) {
    logger.warn(
      { component: 'orchestrator', error: err instanceof Error ? err.message : String(err) },
      'Google Drive OAuth client not loaded — Drive uploads disabled',
    );
  }
}

let onedriveClient: OneDriveOAuthClient | null = null;
try {
  onedriveClient = loadOneDriveOAuthConfig();
  logger.info({ component: 'orchestrator' }, 'OneDrive OAuth client loaded');
} catch (err) {
  logger.warn(
    { component: 'orchestrator', error: err instanceof Error ? err.message : String(err) },
    'OneDrive OAuth client not loaded — OneDrive uploads disabled',
  );
}

let running = false;
const endpointMetrics: Record<
  string,
  { calls: number; ok: number; failed: number; retries: number; totalMs: number }
> = {};

// Per-user dispatch tallies for the current cycle. The scraper delivers each
// notification back via the /api/internal-dispatch callback (handled by
// handleInternalDispatch), so counts are accumulated there and read by
// processUser once the scraper call returns. Reset at the start of each cycle.
const dispatchCounters = new Map<
  string,
  { dispatched: number; processed: number; partial: number }
>();

/**
 * Main orchestration cycle.
 * Fetches active users, calls the scraper, and dispatches each notification.
 */
export async function runOrchestrationCycle(): Promise<void> {
  if (running) {
    logger.info({ component: 'orchestrator' }, 'Cycle already in progress, skipping');
    return;
  }
  running = true;
  dispatchCounters.clear();
  recentDispatchErrors.length = 0;
  const cycleStartedAt = new Date();
  logger.info({ component: 'orchestrator' }, 'Starting orchestration cycle');
  await purgeOldErrors(14).catch(() => {});

  try {
    const users = await getActiveUsers();
    logger.info({ component: 'orchestrator', users: users.length }, 'Loaded active users');
    const cycleStats = {
      usersTotal: users.length,
      usersProcessed: 0,
      usersFailed: 0,
      usersAuthFailed: 0,
      notificationsDispatched: 0,
      notificationsProcessed: 0,
      notificationsPartial: 0,
    };

    // Track users already notified about TEC auth expiration this cycle (1 notification per cycle)
    const tecAuthAlertSent = new Set<string>();

    const concurrencyLimit = parseInt(process.env.CORE_CONCURRENCY ?? '3', 10);
    logger.info({ component: 'orchestrator', concurrencyLimit }, 'Using concurrency level');
    const limit = pLimit(concurrencyLimit);

    const tasks = users.map((user) =>
      limit(async () => {
        try {
          const stats = await processUser(user);
          cycleStats.usersProcessed += 1;
          cycleStats.notificationsDispatched += stats.dispatched;
          cycleStats.notificationsProcessed += stats.processed;
          cycleStats.notificationsPartial += stats.partial;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const isAuthError = errorMsg.includes('Session invalid after re-authentication');

          void insertErrorLog({
            user_id: user.id,
            action: isAuthError ? 'tec_auth_failed' : 'scrape_failed',
            error_message: errorMsg,
          }).catch(() => {});

          if (isAuthError) {
            cycleStats.usersAuthFailed += 1;
            logger.warn(
              {
                component: 'orchestrator',
                userId: user.id,
                action: 'tec_auth_failed',
                errorMessage: errorMsg,
              },
              'User TEC Digital authentication failed — credentials may have changed',
            );

            // Notify the user once per cycle
            if (!tecAuthAlertSent.has(user.id)) {
              tecAuthAlertSent.add(user.id);
              try {
                await telegram.sendTecAuthExpired(user);
                logger.info(
                  { component: 'orchestrator', userId: user.id },
                  'TEC auth expiration notification sent to user',
                );
              } catch (notifyErr) {
                logger.warn(
                  {
                    component: 'orchestrator',
                    userId: user.id,
                    error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
                  },
                  'Failed to send TEC auth expiration notification to user',
                );
              }
            }
          } else {
            cycleStats.usersFailed += 1;
            logger.error(
              {
                component: 'orchestrator',
                userId: user.id,
                action: 'scrape_failed',
                errorMessage: errorMsg,
              },
              'User orchestration failed',
            );
          }
        }
      }),
    );

    await Promise.all(tasks);
    logger.info({ component: 'orchestrator', cycleStats }, 'Cycle metrics');
    logger.info(
      { component: 'orchestrator', endpointMetrics: serializeEndpointMetrics() },
      'Endpoint metrics',
    );
    await evaluateAlerts(cycleStats);

    // Persist the cycle summary so the bot can answer /status from the DB.
    await saveCycleStats({
      started_at: cycleStartedAt,
      finished_at: new Date(),
      users_total: cycleStats.usersTotal,
      users_processed: cycleStats.usersProcessed,
      users_failed: cycleStats.usersFailed,
      users_auth_failed: cycleStats.usersAuthFailed,
      notifications_dispatched: cycleStats.notificationsDispatched,
      notifications_processed: cycleStats.notificationsProcessed,
      notifications_partial: cycleStats.notificationsPartial,
      dominant_error: dominantDispatchError(recentDispatchErrors),
    }).catch((err) =>
      logger.warn(
        {
          component: 'orchestrator',
          errorMessage: err instanceof Error ? err.message : String(err),
        },
        'Failed to persist cycle stats',
      ),
    );
  } finally {
    running = false;
    logger.info({ component: 'orchestrator' }, 'Cycle complete');
  }
}

export async function handleInternalDispatch(
  userId: string,
  notification: import('@tec-brain/types').RawNotification,
  _cookies: ScrapeResponse['cookies'],
): Promise<DispatchResult> {
  const user = await getUserById(userId);
  if (!user) throw new Error('User not found');

  // Build a per-user DriveService from their stored OAuth token
  let storage: DriveService | OneDriveService | null = null;
  if (user.storage_provider === 'drive' && oauthClient && user.drive_root_folder_id) {
    try {
      const encToken = await getDriveOAuthToken(userId);
      if (encToken) {
        const tokenJson = decrypt(encToken);
        storage = DriveService.fromOAuthToken(oauthClient, tokenJson, async (json) => {
          await saveDriveOAuthToken(userId, encrypt(json));
        });
      } else {
        logger.info(
          { component: 'orchestrator', userId },
          'No Drive OAuth token for user — Drive uploads skipped',
        );
      }
    } catch (err) {
      logger.warn(
        {
          component: 'orchestrator',
          userId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to load Drive OAuth token — Drive uploads skipped',
      );
    }
  }

  if (user.storage_provider === 'onedrive' && onedriveClient && user.onedrive_root_folder_id) {
    try {
      const encToken = await getOneDriveOAuthToken(userId);
      if (encToken) {
        const tokenJson = decrypt(encToken);
        storage = OneDriveService.fromOAuthToken(onedriveClient, tokenJson, async (json) => {
          await saveOneDriveOAuthToken(userId, encrypt(json));
        });
      } else {
        logger.info(
          { component: 'orchestrator', userId },
          'No OneDrive OAuth token for user — OneDrive uploads skipped',
        );
      }
    } catch (err) {
      logger.warn(
        {
          component: 'orchestrator',
          userId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to load OneDrive OAuth token — OneDrive uploads skipped',
      );
    }
  }

  const result = await dispatch(
    user,
    notification,
    SCRAPER_URL,
    decrypt(user.tec_password_enc),
    telegram,
    storage,
  );

  // Tally only real delivery attempts (skip muted/duplicate) so cycle metrics
  // and the partial-rate alert reflect actual work.
  if (result.reason === 'processed' || result.reason === 'partial_or_failed') {
    const c = dispatchCounters.get(userId) ?? { dispatched: 0, processed: 0, partial: 0 };
    c.dispatched += 1;
    if (result.reason === 'processed') c.processed += 1;
    else c.partial += 1;
    dispatchCounters.set(userId, c);
  }

  return result;
}

async function processUser(
  user: Awaited<ReturnType<typeof getActiveUsers>>[0],
): Promise<{ dispatched: number; processed: number; partial: number }> {
  logger.info(
    {
      component: 'orchestrator',
      userId: user.id,
      userName: user.name,
      tecUsername: user.tec_username,
    },
    'Starting user scrape',
  );

  const password = decrypt(user.tec_password_enc);

  // Retry StudyOS deliveries that failed in previous cycles (no-op if the
  // user has no StudyOS configured). Never blocks the scrape.
  await retryStudyosPending(user).catch((err) =>
    logger.warn(
      {
        component: 'orchestrator',
        userId: user.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      'StudyOS retry sweep failed',
    ),
  );

  const scraperSecret = process.env.SCRAPER_SECRET;

  // Evaluations rubric sweep (throttled inside; no-op without StudyOS config).
  await syncEvaluations(
    user,
    async (username, tecPassword) => {
      const res = await axios.post<{ status: string; courses: never[]; error?: string }>(
        `${SCRAPER_URL}/scrape-evaluations`,
        { username, password: tecPassword },
        { timeout: 300_000, headers: scraperSecret ? { 'x-scraper-secret': scraperSecret } : {} },
      );
      if (res.data.status !== 'success') {
        throw new Error(res.data.error || 'scrape-evaluations failed');
      }
      return res.data.courses;
    },
    { username: user.tec_username, password },
    (async (downloadUrl: string) => {
      const res = await axios.post<ArrayBuffer>(
        `${SCRAPER_URL}/download-file`,
        { username: user.tec_username, password, downloadUrl },
        {
          responseType: 'arraybuffer',
          timeout: 60_000,
          headers: scraperSecret ? { 'x-scraper-secret': scraperSecret } : {},
        },
      );
      const contentType =
        (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
      return { data: res.data, contentType };
    }) satisfies FileDownloader,
  ).catch((err) =>
    logger.warn(
      {
        component: 'orchestrator',
        userId: user.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      'Evaluations sweep failed',
    ),
  );

  // Alert queue (upcoming deadlines, published grades) → Telegram.
  await forwardStudyosAlerts(user, (html) =>
    telegram.sendMessage(user.telegram_chat_id, html),
  );

  const response = await requestWithRetry(
    () =>
      axios.post<ScrapeResponse>(
        `${SCRAPER_URL}/process-sequential/${user.id}`,
        {
          username: user.tec_username,
          password,
          dispatchUrl: `http://core:${process.env.PORT ?? '3002'}/api/internal-dispatch`,
          dispatchSecret: process.env.INTERNAL_API_SECRET ?? '',
        },
        {
          timeout: 300_000,
          headers: scraperSecret ? { 'x-scraper-secret': scraperSecret } : {},
        },
      ),
    'scraper.process_sequential',
  );

  if (response.data.status === 'error') {
    throw new Error(response.data.error || 'Unknown scraper error');
  }

  // By the time the scraper call resolves, it has POSTed every notification
  // back through /api/internal-dispatch, so the counters for this user are final.
  const counts = dispatchCounters.get(user.id) ?? { dispatched: 0, processed: 0, partial: 0 };
  dispatchCounters.delete(user.id);

  logger.info(
    {
      component: 'orchestrator',
      userId: user.id,
      userName: user.name,
      mode: 'api',
      ...counts,
    },
    'Sequential scrape finished',
  );
  return counts;
}

async function evaluateAlerts(cycleStats: {
  usersTotal: number;
  usersProcessed: number;
  usersFailed: number;
  usersAuthFailed: number;
  notificationsDispatched: number;
  notificationsProcessed: number;
  notificationsPartial: number;
}): Promise<void> {
  const partialPct =
    cycleStats.notificationsDispatched > 0
      ? Math.round((cycleStats.notificationsPartial / cycleStats.notificationsDispatched) * 100)
      : 0;

  const alerts: Array<{ key: string; text: string }> = [];
  if (partialPct >= ALERT_PARTIAL_THRESHOLD_PCT) {
    const dominant = dominantDispatchError(recentDispatchErrors);
    alerts.push({
      key: 'notifications_partial',
      text:
        `⚠️ ${cycleStats.notificationsPartial}/${cycleStats.notificationsDispatched} notificaciones (${partialPct}%) fallaron y se reintentarán cada ciclo` +
        (dominant ? `. Error dominante: ${dominant}` : ''),
    });
  }
  if (cycleStats.usersFailed >= ALERT_USER_FAILURES_THRESHOLD) {
    alerts.push({
      key: 'users_failed',
      text: `⚠️ ${cycleStats.usersFailed}/${cycleStats.usersTotal} usuarios fallaron el scrape`,
    });
  }

  if (alerts.length > 0) {
    logger.error(
      {
        component: 'orchestrator',
        alerts: alerts.map((a) => a.text),
        cycleStats,
      },
      'Automatic cycle alerts triggered',
    );
  }

  if (!ADMIN_ALERT_CHAT_ID) return;

  const transitions = selectAlertTransitions(
    alerts,
    adminAlertTimestamps,
    Date.now(),
    ADMIN_ALERT_REMIND_MS,
  );
  for (const t of transitions) {
    const text =
      t.kind === 'recovered'
        ? `✅ Resuelto: ${t.key} volvió a la normalidad`
        : t.kind === 'reminder'
          ? `${t.text} (sigue activo)`
          : t.text;
    try {
      await telegram.sendMessage(ADMIN_ALERT_CHAT_ID, escapeHtml(text));
    } catch (error) {
      logger.error(
        { component: 'orchestrator', error },
        'Failed to send admin alert via Telegram',
      );
    }
  }
}

export interface AlertTransition {
  key: string;
  text: string;
  kind: 'fired' | 'reminder' | 'recovered';
}

/**
 * State-transition alert selection: an alert is sent once when its key starts
 * firing, re-sent as a reminder every `remindMs` while it stays active, and a
 * recovery notice is emitted when it stops firing. `state` maps key → last-sent
 * ms (presence = currently firing) and is mutated in place. Pure aside from
 * that mutation — no env, network, or clock reads — so it is unit-testable.
 */
export function selectAlertTransitions(
  active: Array<{ key: string; text: string }>,
  state: Record<string, number>,
  now: number,
  remindMs: number,
): AlertTransition[] {
  const out: AlertTransition[] = [];
  const activeKeys = new Set(active.map((a) => a.key));

  for (const key of Object.keys(state)) {
    if (!activeKeys.has(key)) {
      delete state[key];
      out.push({ key, text: '', kind: 'recovered' });
    }
  }

  for (const alert of active) {
    const lastSent = state[alert.key];
    if (lastSent === undefined) {
      state[alert.key] = now;
      out.push({ ...alert, kind: 'fired' });
    } else if (now - lastSent >= remindMs) {
      state[alert.key] = now;
      out.push({ ...alert, kind: 'reminder' });
    }
  }

  return out;
}

/**
 * Most frequent message in the cycle's dispatch-error window, formatted as
 * "action: message (n/total)". Null when the window is empty.
 */
export function dominantDispatchError(errors: readonly string[]): string | null {
  if (errors.length === 0) return null;
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return `${top} (${n}/${errors.length})`;
}

async function requestWithRetry<T>(request: () => Promise<T>, endpoint: string): Promise<T> {
  const maxAttempts = Math.max(1, HTTP_RETRY_ATTEMPTS);
  const metric = getMetric(endpoint);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await request();
      metric.calls += 1;
      metric.ok += 1;
      metric.totalMs += Date.now() - startedAt;
      if (attempt > 1) metric.retries += attempt - 1;
      return result;
    } catch (error) {
      metric.calls += 1;
      metric.failed += 1;
      metric.totalMs += Date.now() - startedAt;

      if (!isRetryableHttpError(error) || attempt === maxAttempts) {
        throw error;
      }

      const sleepMs = backoffWithJitter(attempt, HTTP_RETRY_BASE_MS);
      logger.warn(
        { component: 'orchestrator', endpoint, attempt, sleepMs },
        'Retrying endpoint call',
      );
      await sleep(sleepMs);
    }
  }

  throw new Error(`Retry loop exhausted for ${endpoint}`);
}

function getMetric(endpoint: string): {
  calls: number;
  ok: number;
  failed: number;
  retries: number;
  totalMs: number;
} {
  if (!endpointMetrics[endpoint]) {
    endpointMetrics[endpoint] = { calls: 0, ok: 0, failed: 0, retries: 0, totalMs: 0 };
  }
  return endpointMetrics[endpoint];
}

function serializeEndpointMetrics(): Array<Record<string, unknown>> {
  return Object.entries(endpointMetrics).map(([endpoint, metric]) => ({
    endpoint,
    ...metric,
    avgMs: metric.calls > 0 ? Math.round(metric.totalMs / metric.calls) : 0,
  }));
}

// Transient low-level network conditions worth retrying when there is no HTTP
// response (connection reset, timeout, transient DNS failure).
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);

function isRetryableHttpError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false; // unknown bug (e.g. TypeError): do not retry
  const status = error.response?.status;
  if (status === undefined) {
    // No HTTP response — retry only known transient network errors.
    return error.code !== undefined && TRANSIENT_NETWORK_CODES.has(error.code);
  }
  return status >= 500 || status === 408 || status === 429;
}

function backoffWithJitter(attempt: number, baseMs: number): number {
  const cappedAttempt = Math.min(attempt, 6);
  const exp = baseMs * 2 ** (cappedAttempt - 1);
  const jitter = Math.floor(Math.random() * baseMs);
  return exp + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
