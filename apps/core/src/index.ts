import 'dotenv/config';
import Fastify from 'fastify';
import cron from 'node-cron';
import { getPool, runMigrations } from '@tec-brain/database';
import { runOrchestrationCycle, handleInternalDispatch } from './orchestrator.js';
import type { RawNotification, ScrapeResponse } from '@tec-brain/types';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT ?? '3002', 10);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '*/5 * * * *'; // Every 5 min

async function main() {
    logger.info({ component: 'core_startup' }, 'Running database migrations');
    await runMigrations();
    logger.info({ component: 'core_startup' }, 'Migrations complete');

    // 2. Start health check Fastify server
    const fastify = Fastify({ logger: { level: 'info' } });

    fastify.get('/health', async () => ({
        status: 'ok',
        uptime_s: Math.floor(process.uptime()),
    }));

    // Manual trigger for testing
    fastify.post('/api/run-now', async () => {
        setImmediate(() => void runOrchestrationCycle());
        return { status: 'triggered' };
    });

    fastify.post<{
        Body: { userId: string; notification: RawNotification; cookies: ScrapeResponse['cookies'] }
    }>('/api/internal-dispatch', async (request, reply) => {
        try {
            const { userId, notification, cookies } = request.body;
            const result = await handleInternalDispatch(userId, notification, cookies);
            return { status: 'success', processed: result.processed, reason: result.reason };
        } catch (error) {
            request.log.error(error);
            return reply.status(500).send({ status: 'error', processed: false, error: String(error) });
        }
    });

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    logger.info({ component: 'core_startup', port: PORT }, 'Core listening');

    if (!cron.validate(CRON_SCHEDULE)) {
        logger.error({ component: 'core_startup', cronSchedule: CRON_SCHEDULE }, 'Invalid CRON_SCHEDULE');
        process.exit(1);
    }

    const job = cron.schedule(CRON_SCHEDULE, () => {
        logger.info({ component: 'core_cron', cronSchedule: CRON_SCHEDULE }, 'Running scheduled orchestration cycle');
        void runOrchestrationCycle();
    });

    logger.info({ component: 'core_startup', cronSchedule: CRON_SCHEDULE }, 'Cron scheduled');
    logger.info({ component: 'core_startup' }, 'Running initial orchestration cycle');
    await runOrchestrationCycle();

    const shutdown = async () => {
        job.stop();
        await fastify.close();
        await getPool().end();
        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
    logger.fatal({ component: 'core_startup', err }, 'Fatal startup error');
    process.exit(1);
});
