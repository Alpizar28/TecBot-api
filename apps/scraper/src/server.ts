import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { SessionManager } from './sessions/session-manager.js';
import { processNotificationsSequentially } from './extractors/notifications.js';
import type { ScrapeResponse } from '@tec-brain/types';

const SESSION_DIR = process.env.SESSION_DIR ?? './data/sessions';

let sessionManager: SessionManager;

export function buildServer(): FastifyInstance {
    const fastify = Fastify({
        logger: {
            level: process.env.LOG_LEVEL ?? 'info',
        },
    });

    void fastify.register(sensible);

    sessionManager = new SessionManager(SESSION_DIR, fastify.log);

    // ── Health Check ──────────────────────────────────────────────────────────
    fastify.get('/health', async (_, reply) => {
        return reply.send({ status: 'ok', uptime_s: Math.floor(process.uptime()) });
    });

    // ── Sequential Scrape Endpoint ────────────────────────────────────────────
    fastify.post<{
        Params: { userId: string };
        Body: { username: string; password: string; keywords?: string[]; dispatchUrl: string };
    }>(
        '/process-sequential/:userId',
        {
            schema: {
                params: {
                    type: 'object',
                    properties: { userId: { type: 'string' } },
                    required: ['userId'],
                },
                body: {
                    type: 'object',
                    properties: {
                        username: { type: 'string' },
                        password: { type: 'string' },
                        dispatchUrl: { type: 'string', format: 'uri' },
                        keywords: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['username', 'password', 'dispatchUrl'],
                },
            },
        },
        async (request, reply): Promise<ScrapeResponse> => {
            const { userId } = request.params;
            const { username, password, dispatchUrl, keywords = [] } = request.body;

            try {
                const client = await sessionManager.getClient(username, password);
                const cookies = await sessionManager.getCookies(client);

                await processNotificationsSequentially(client, userId, dispatchUrl, cookies, keywords);

                return reply.send({
                    status: 'success',
                    user_id: userId,
                    notifications: [], // Return empty array since they were dispatched individually
                    cookies,
                } satisfies ScrapeResponse);
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                request.log.error({ err, userId }, 'Sequential scrape failed');

                return reply.status(500).send({
                    status: 'error',
                    user_id: userId,
                    notifications: [],
                    cookies: [],
                    error,
                } satisfies ScrapeResponse);
            }
        },
    );

    return fastify;
}
