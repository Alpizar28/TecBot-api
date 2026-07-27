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
  getAdminAlertStates,
  saveAdminAlertStates,
  type AdminAlertState,
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
import {
  processUserNotifications,
  getUserEvaluations,
  downloadTecFile,
} from './scraper/index.js';
import { logger } from './logger.js';
const ALERT_PARTIAL_THRESHOLD_PCT = parseInt(process.env.ALERT_PARTIAL_THRESHOLD_PCT ?? '20', 10);
const ALERT_USER_FAILURES_THRESHOLD = parseInt(
  process.env.ALERT_USER_FAILURES_THRESHOLD ?? '1',
  10,
);
const ALERT_USER_FAILURES_CONSECUTIVE = parseInt(
  process.env.ALERT_USER_FAILURES_CONSECUTIVE ?? '2',
  10,
);
const ALERT_USER_RECOVERY_CONSECUTIVE = parseInt(
  process.env.ALERT_USER_RECOVERY_CONSECUTIVE ?? '2',
  10,
);
const ADMIN_ALERT_CHAT_ID = process.env.ADMIN_ALERT_CHAT_ID ?? '';
// While a failure stays broken, remind at most this often (default 6 h);
// otherwise alerts fire only on state transitions (started failing / recovered).
const ADMIN_ALERT_REMIND_MS =
  parseInt(process.env.ADMIN_ALERT_COOLDOWN_MINUTES ?? '360', 10) * 60_000;

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
          const action = isAuthError
            ? 'tec_auth_failed'
            : 'orchestration_failed';

          void insertErrorLog({
            user_id: user.id,
            action,
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
            logger.error(
              {
                component: 'orchestrator',
                userId: user.id,
                action: 'orchestration_failed',
                errorMessage: errorMsg,
              },
              'User orchestration failed outside scraper',
            );
          }
        }
      }),
    );

    await Promise.all(tasks);
    logger.info({ component: 'orchestrator', cycleStats }, 'Cycle metrics');
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

  // Evaluations rubric sweep (throttled inside; no-op without StudyOS config).
  await syncEvaluations(
    user,
    async (username, tecPassword) => {
      const courses = await getUserEvaluations(username, tecPassword);
      return courses as never[];
    },
    { username: user.tec_username, password },
    (async (downloadUrl: string) => {
      const result = await downloadTecFile(user.tec_username, password, downloadUrl);
      if (!result) throw new Error('Failed to download file');
      return result;
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
  await forwardStudyosAlerts(user, (html) => telegram.sendMessage(user.telegram_chat_id, html));

  try {
    const result = await processUserNotifications(
      user.tec_username,
      password,
      user.id,
      (notification) => handleInternalDispatch(user.id, notification, []),
    );

    if (result === 'error') {
      throw new Error('Sequential notification processing failed');
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
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

  const dominant = dominantDispatchError(recentDispatchErrors);
  const alerts: AlertObservation[] = [
    {
      key: 'notifications_partial',
      text:
        `⚠️ ${cycleStats.notificationsPartial}/${cycleStats.notificationsDispatched} notificaciones (${partialPct}%) fallaron y se reintentarán cada ciclo` +
        (dominant ? `. Error dominante: ${dominant}` : ''),
      active: partialPct >= ALERT_PARTIAL_THRESHOLD_PCT,
      failureCycles: 1,
      recoveryCycles: 1,
    },
    {
      key: 'users_failed',
      text: `⚠️ ${cycleStats.usersFailed}/${cycleStats.usersTotal} usuarios fallaron el scrape`,
      active: cycleStats.usersFailed >= ALERT_USER_FAILURES_THRESHOLD,
      failureCycles: ALERT_USER_FAILURES_CONSECUTIVE,
      recoveryCycles: ALERT_USER_RECOVERY_CONSECUTIVE,
    },
  ];
  const activeAlerts = alerts.filter((alert) => alert.active);

  if (activeAlerts.length > 0) {
    logger.error(
      {
        component: 'orchestrator',
        alerts: activeAlerts.map((alert) => alert.text),
        cycleStats,
      },
      'Automatic cycle alerts triggered',
    );
  }

  if (!ADMIN_ALERT_CHAT_ID) return;

  let transitions: AlertTransition[];
  try {
    const persisted = await getAdminAlertStates(alerts.map((alert) => alert.key));
    const state = Object.fromEntries(
      persisted.map((entry) => [entry.alert_key, toAlertState(entry)]),
    ) as Record<string, AlertState>;
    transitions = selectAlertTransitions(alerts, state, Date.now(), ADMIN_ALERT_REMIND_MS);
    await saveAdminAlertStates(Object.values(state).map(toPersistedAlertState));
  } catch (error) {
    logger.error(
      { component: 'orchestrator', error },
      'Failed to load or persist admin alert state',
    );
    return;
  }
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
      logger.error({ component: 'orchestrator', error }, 'Failed to send admin alert via Telegram');
    }
  }
}

export interface AlertTransition {
  key: string;
  text: string;
  kind: 'fired' | 'reminder' | 'recovered';
}

export interface AlertObservation {
  key: string;
  text: string;
  active: boolean;
  failureCycles: number;
  recoveryCycles: number;
}

export interface AlertState {
  key: string;
  isFiring: boolean;
  failureStreak: number;
  recoveryStreak: number;
  lastSentAt: number | null;
}

/**
 * State-transition alert selection with consecutive-cycle debounce. State is
 * supplied by the database and mutated in place so callers can persist it.
 */
export function selectAlertTransitions(
  observations: AlertObservation[],
  state: Record<string, AlertState>,
  now: number,
  remindMs: number,
): AlertTransition[] {
  const out: AlertTransition[] = [];

  for (const alert of observations) {
    const current =
      state[alert.key] ??
      ({
        key: alert.key,
        isFiring: false,
        failureStreak: 0,
        recoveryStreak: 0,
        lastSentAt: null,
      } satisfies AlertState);

    if (alert.active) {
      current.failureStreak += 1;
      current.recoveryStreak = 0;
      if (!current.isFiring && current.failureStreak >= Math.max(1, alert.failureCycles)) {
        current.isFiring = true;
        current.lastSentAt = now;
        out.push({ key: alert.key, text: alert.text, kind: 'fired' });
      } else if (
        current.isFiring &&
        current.lastSentAt !== null &&
        now - current.lastSentAt >= remindMs
      ) {
        current.lastSentAt = now;
        out.push({ key: alert.key, text: alert.text, kind: 'reminder' });
      }
    } else {
      current.failureStreak = 0;
      current.recoveryStreak = current.isFiring ? current.recoveryStreak + 1 : 0;
      if (current.isFiring && current.recoveryStreak >= Math.max(1, alert.recoveryCycles)) {
        current.isFiring = false;
        current.recoveryStreak = 0;
        current.lastSentAt = null;
        out.push({ key: alert.key, text: '', kind: 'recovered' });
      }
    }
    state[alert.key] = current;
  }

  return out;
}

function toAlertState(entry: AdminAlertState): AlertState {
  return {
    key: entry.alert_key,
    isFiring: entry.is_firing,
    failureStreak: entry.failure_streak,
    recoveryStreak: entry.recovery_streak,
    lastSentAt: entry.last_sent_at?.getTime() ?? null,
  };
}

function toPersistedAlertState(state: AlertState): AdminAlertState {
  return {
    alert_key: state.key,
    is_firing: state.isFiring,
    failure_streak: state.failureStreak,
    recovery_streak: state.recoveryStreak,
    last_sent_at: state.lastSentAt === null ? null : new Date(state.lastSentAt),
  };
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
