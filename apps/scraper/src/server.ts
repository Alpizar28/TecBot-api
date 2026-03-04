import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import helmet from '@fastify/helmet';
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
  void fastify.register(helmet, { global: true });

  sessionManager = new SessionManager(SESSION_DIR, fastify.log);

  // ── Health Check ──────────────────────────────────────────────────────────
  fastify.get('/health', async (_, reply) => {
    return reply.send({ status: 'ok', uptime_s: Math.floor(process.uptime()) });
  });

  // ── Sequential Scrape Endpoint ────────────────────────────────────────────
  fastify.post<{
    Params: { userId: string };
    Body: {
      username: string;
      password: string;
      keywords?: string[];
      dispatchUrl: string;
      dispatchSecret?: string;
    };
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
            dispatchSecret: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
          },
          required: ['username', 'password', 'dispatchUrl'],
        },
      },
    },
    async (request, reply): Promise<ScrapeResponse> => {
      const { userId } = request.params;
      const { username, password, dispatchUrl, dispatchSecret = '', keywords = [] } = request.body;

      try {
        const client = await sessionManager.getClient(username, password);
        const cookies = await sessionManager.getCookies(client);

        await processNotificationsSequentially(
          client,
          userId,
          dispatchUrl,
          cookies,
          keywords,
          dispatchSecret,
        );

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

  // ── File Download Proxy Endpoint ──────────────────────────────────────────
  // Downloads a TEC Digital file using the active session for the given user.
  // The core calls this instead of downloading directly, since the session
  // cookies are only valid within the scraper's CookieJar context.
  fastify.post<{
    Body: { username: string; password: string; downloadUrl: string };
  }>(
    '/download-file',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
            downloadUrl: { type: 'string' },
          },
          required: ['username', 'password', 'downloadUrl'],
        },
      },
    },
    async (request, reply) => {
      const { username, password, downloadUrl } = request.body;

      try {
        const client = await sessionManager.getClient(username, password);
        const response = await client.client.get<ArrayBuffer>(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxRedirects: 5,
        });

        const contentType =
          (response.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
        const contentDisposition = response.headers['content-disposition'] as string | undefined;

        void reply.header('content-type', contentType);
        if (contentDisposition) {
          void reply.header('content-disposition', contentDisposition);
        }

        return reply.send(Buffer.from(response.data));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const status = (err as { response?: { status?: number } }).response?.status ?? 500;
        request.log.error({ err, username, downloadUrl }, 'File download failed');
        return reply.status(status >= 400 && status < 600 ? status : 500).send({ error });
      }
    },
  );

  return fastify;
}
