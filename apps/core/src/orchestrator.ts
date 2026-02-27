import axios from 'axios';
import { getActiveUsers, getUserById, decrypt } from '@tec-brain/database';
import { TelegramService } from '@tec-brain/telegram';
import { DriveService } from '@tec-brain/drive';
import { dispatch, type DispatchResult } from './dispatcher.js';
import pLimit from 'p-limit';
import type { ScrapeResponse } from '@tec-brain/types';
import { logger } from './logger.js';

const SCRAPER_URL = process.env.SCRAPER_URL ?? 'http://scraper:3001';

// Singletons shared across cron invocations
const telegram = new TelegramService(process.env.TELEGRAM_BOT_TOKEN ?? '');
const drive = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH
    ? new DriveService(process.env.GOOGLE_DRIVE_CREDENTIALS_PATH)
    : null;

let running = false;

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

    const response = await axios.post<ScrapeResponse>(
        `${SCRAPER_URL}/process-sequential/${user.id}`,
        {
            username: user.tec_username,
            password,
            dispatchUrl: `http://core:${process.env.PORT ?? '3002'}/api/internal-dispatch`,
        },
        { timeout: 300_000 },
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
