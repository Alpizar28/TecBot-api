import axios from 'axios';
import { getActiveUsers, getUserById, decrypt } from '@tec-brain/database';
import { TelegramService } from '@tec-brain/telegram';
import { DriveService } from '@tec-brain/drive';
import { dispatch, type DispatchResult } from './dispatcher.js';
import pLimit from 'p-limit';
import type { ScrapeResponse } from '@tec-brain/types';
import { logger } from './logger.js';

const SCRAPER_URL = process.env.SCRAPER_URL ?? 'http://scraper:3001';
const HTTP_RETRY_ATTEMPTS = parseInt(process.env.HTTP_RETRY_ATTEMPTS ?? '3', 10);
const HTTP_RETRY_BASE_MS = parseInt(process.env.HTTP_RETRY_BASE_MS ?? '400', 10);
const ALERT_PARTIAL_THRESHOLD_PCT = parseInt(process.env.ALERT_PARTIAL_THRESHOLD_PCT ?? '20', 10);
const ALERT_USER_FAILURES_THRESHOLD = parseInt(process.env.ALERT_USER_FAILURES_THRESHOLD ?? '1', 10);
const ADMIN_ALERT_CHAT_ID = process.env.ADMIN_ALERT_CHAT_ID ?? '';

// Singletons shared across cron invocations
const telegram = new TelegramService(process.env.TELEGRAM_BOT_TOKEN ?? '');
const drive = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH
    ? new DriveService(process.env.GOOGLE_DRIVE_CREDENTIALS_PATH)
    : null;

let running = false;
const endpointMetrics: Record<string, { calls: number; ok: number; failed: number; retries: number; totalMs: number }> = {};

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
    logger.info({ component: 'orchestrator' }, 'Starting orchestration cycle');

    try {
        const users = await getActiveUsers();
        logger.info({ component: 'orchestrator', users: users.length }, 'Loaded active users');
        const cycleStats = {
            usersTotal: users.length,
            usersProcessed: 0,
            usersFailed: 0,
            notificationsDispatched: 0,
            notificationsProcessed: 0,
            notificationsPartial: 0,
        };

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
                    cycleStats.usersFailed += 1;
                    logger.error({
                        component: 'orchestrator',
                        userId: user.id,
                        action: 'scrape_failed',
                        errorMessage: errorMsg,
                    }, 'User orchestration failed');
                }
            })
        );

        await Promise.all(tasks);
        logger.info({ component: 'orchestrator', cycleStats }, 'Cycle metrics');
        logger.info({ component: 'orchestrator', endpointMetrics: serializeEndpointMetrics() }, 'Endpoint metrics');
        await evaluateAlerts(cycleStats);

    } finally {
        running = false;
        logger.info({ component: 'orchestrator' }, 'Cycle complete');
    }
}

export async function handleInternalDispatch(
    userId: string,
    notification: import('@tec-brain/types').RawNotification,
    cookies: ScrapeResponse['cookies']
): Promise<DispatchResult> {
    const user = await getUserById(userId);
    if (!user) throw new Error('User not found');
    return dispatch(user, notification, cookies, telegram, drive);
}

async function processUser(
    user: Awaited<ReturnType<typeof getActiveUsers>>[0],
): Promise<{ dispatched: number; processed: number; partial: number }> {
    logger.info({
        component: 'orchestrator',
        userId: user.id,
        userName: user.name,
        tecUsername: user.tec_username,
    }, 'Starting user scrape');

    const password = decrypt(user.tec_password_enc);

    const response = await requestWithRetry(
        () => axios.post<ScrapeResponse>(
            `${SCRAPER_URL}/process-sequential/${user.id}`,
            {
                username: user.tec_username,
                password,
                dispatchUrl: `http://core:${process.env.PORT ?? '3002'}/api/internal-dispatch`,
            },
            { timeout: 300_000 },
        ),
        'scraper.process_sequential',
    );

    if (response.data.status === 'error') {
        throw new Error(response.data.error || 'Unknown scraper error');
    }

    logger.info({
        component: 'orchestrator',
        userId: user.id,
        userName: user.name,
        mode: 'api',
    }, 'Sequential scrape finished');
    return { dispatched: 0, processed: 0, partial: 0 };
}

async function evaluateAlerts(cycleStats: {
    usersTotal: number;
    usersProcessed: number;
    usersFailed: number;
    notificationsDispatched: number;
    notificationsProcessed: number;
    notificationsPartial: number;
}): Promise<void> {
    const partialPct =
        cycleStats.notificationsDispatched > 0
            ? Math.round((cycleStats.notificationsPartial / cycleStats.notificationsDispatched) * 100)
            : 0;

    const messages: string[] = [];
    if (partialPct >= ALERT_PARTIAL_THRESHOLD_PCT) {
        messages.push(
            `ALERTA API-ONLY: notifications_partial=${cycleStats.notificationsPartial}/${cycleStats.notificationsDispatched} (${partialPct}%)`,
        );
    }
    if (cycleStats.usersFailed >= ALERT_USER_FAILURES_THRESHOLD) {
        messages.push(
            `ALERTA API-ONLY: users_failed=${cycleStats.usersFailed}/${cycleStats.usersTotal}`,
        );
    }

    if (messages.length === 0) return;

    logger.error({
        component: 'orchestrator',
        alerts: messages,
        cycleStats,
    }, 'Automatic cycle alerts triggered');

    if (!ADMIN_ALERT_CHAT_ID) return;
    try {
        for (const message of messages) {
            await telegram.sendMessage(ADMIN_ALERT_CHAT_ID, escapeHtml(message));
        }
    } catch (error) {
        logger.error({ component: 'orchestrator', error }, 'Failed to send admin alert via Telegram');
    }
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
            logger.warn({ component: 'orchestrator', endpoint, attempt, sleepMs }, 'Retrying endpoint call');
            await sleep(sleepMs);
        }
    }

    throw new Error(`Retry loop exhausted for ${endpoint}`);
}

function getMetric(endpoint: string): { calls: number; ok: number; failed: number; retries: number; totalMs: number } {
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

function isRetryableHttpError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return true;
    const status = error.response?.status;
    if (!status) return true;
    return status >= 500 || status === 408 || status === 429;
}

function backoffWithJitter(attempt: number, baseMs: number): number {
    const cappedAttempt = Math.min(attempt, 6);
    const exp = baseMs * (2 ** (cappedAttempt - 1));
    const jitter = Math.floor(Math.random() * baseMs);
    return exp + jitter;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
