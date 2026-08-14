import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import {
  getPool,
  runMigrations,
  saveDriveOAuthToken,
  saveOneDriveOAuthToken,
  encrypt,
  createOAuthState,
  consumeOAuthState,
  purgeExpiredOAuthStates,
  reEncryptLegacyCbcRows,
} from '@tec-brain/database';
import { runOrchestrationCycle, handleInternalDispatch } from './orchestrator.js';
import {
  loadOAuthClientConfig,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  loadOneDriveOAuthConfig,
  getOneDriveAuthorizationUrl,
  exchangeOneDriveCodeForTokens,
} from '@tec-brain/drive';
import type { RawNotification, ScrapeResponse } from '@tec-brain/types';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT ?? '3002', 10);
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS ?? '300000', 10);
const MAX_CYCLE_BACKOFF_MS = parseInt(process.env.MAX_CYCLE_BACKOFF_MS ?? '3600000', 10);
const BASE_CYCLE_BACKOFF_MS = parseInt(process.env.BASE_CYCLE_BACKOFF_MS ?? '30000', 10);

/**
 * Constant-time comparison of a request-provided secret against the expected
 * value. Rejects arrays/undefined and length mismatches without leaking timing.
 */
function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function main() {
  logger.info({ component: 'core_startup' }, 'Running database migrations');
  await runMigrations();
  logger.info({ component: 'core_startup' }, 'Migrations complete');
  logger.info({ component: 'core_startup' }, 'Re-encrypting legacy CBC rows to AES-256-GCM');
  await reEncryptLegacyCbcRows();
  logger.info({ component: 'core_startup' }, 'Encryption upgrade complete');

  // Load OAuth client config if available
  const oauthClientPath = process.env.GOOGLE_OAUTH_CLIENT_PATH;
  const oauthClient = oauthClientPath
    ? (() => {
        try {
          return loadOAuthClientConfig(oauthClientPath);
        } catch (err) {
          logger.warn(
            { component: 'core_startup', error: String(err) },
            'OAuth client config not loaded',
          );
          return null;
        }
      })()
    : null;

  const onedriveClient = (() => {
    try {
      return loadOneDriveOAuthConfig();
    } catch (err) {
      logger.warn(
        { component: 'core_startup', error: String(err) },
        'OneDrive OAuth config not loaded',
      );
      return null;
    }
  })();

  // 2. Start health check Fastify server
  const fastify = Fastify({ logger: { level: 'info' } });
  await fastify.register(helmet, { global: true });

  fastify.get('/health', async () => ({
    status: 'ok',
    uptime_s: Math.floor(process.uptime()),
  }));

  const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
  if (!INTERNAL_API_SECRET) {
    // Fail closed: refuse to boot with unprotected internal endpoints in
    // production. Allow it only for local development.
    if (process.env.NODE_ENV !== 'development') {
      throw new Error(
        'INTERNAL_API_SECRET is required outside development — refusing to start with ' +
          'unprotected /api/run-now and /api/internal-dispatch. Set the variable, or set ' +
          'NODE_ENV=development to allow an unprotected local run.',
      );
    }
    logger.warn(
      { component: 'core_startup' },
      'INTERNAL_API_SECRET is not set — internal endpoints are UNPROTECTED (development mode).',
    );
  }

  function requireInternalSecret(
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): boolean {
    if (!INTERNAL_API_SECRET) return true; // dev-only: startup already allowed this
    const provided = request.headers['x-internal-secret'];
    if (!secretsMatch(provided, INTERNAL_API_SECRET)) {
      void reply.status(401).send({ status: 'error', error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // Manual trigger for testing — requires x-internal-secret header
  fastify.post<{ Body: { keywords?: string[]; courseId?: string } }>('/api/run-now', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;
    const keywords = Array.isArray(request.body?.keywords)
      ? request.body.keywords.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const courseId = typeof request.body?.courseId === 'string' ? request.body.courseId.trim() : '';
    setImmediate(() => void runOrchestrationCycle(keywords, courseId));
    return { status: 'triggered', keywords, courseId };
  });

  fastify.post<{
    Body: { userId: string; notification: RawNotification; cookies: ScrapeResponse['cookies']; courseId?: string };
  }>('/api/internal-dispatch', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;
    try {
      const { userId, notification, cookies, courseId = '' } = request.body;
      const result = await handleInternalDispatch(userId, notification, cookies, courseId);
      return { status: 'success', processed: result.processed, reason: result.reason };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ status: 'error', processed: false, error: String(error) });
    }
  });

  // ─── Google Drive OAuth flow ─────────────────────────────────────────────
  // Step 1: GET /auth/drive?userId=<uuid>
  //   → Redirects the user to Google's consent page.
  fastify.get<{ Querystring: { userId?: string } }>('/auth/drive', async (request, reply) => {
    if (!oauthClient) {
      return reply
        .status(503)
        .send({ error: 'OAuth client not configured (GOOGLE_OAUTH_CLIENT_PATH missing)' });
    }
    const { userId } = request.query;
    if (!userId) return reply.status(400).send({ error: 'Missing userId query param' });

    // Generate secure state nonce for CSRF protection
    const state = await createOAuthState(userId);
    const authUrl = getAuthorizationUrl(oauthClient, state);
    return reply.redirect(authUrl);
  });

  // Step 2: GET /auth/drive/callback?code=...&state=...
  //   → Exchanges code for tokens, encrypts and stores them in DB.
  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/drive/callback',
    async (request, reply) => {
      if (!oauthClient) {
        return reply.status(503).send({ error: 'OAuth client not configured' });
      }
      const { code, state, error } = request.query;
      if (error) return reply.status(400).send({ error: `Google returned: ${error}` });
      if (!code || !state) return reply.status(400).send({ error: 'Missing code or state' });

      let userId: string | null;
      try {
        userId = await consumeOAuthState(state);
      } catch (err) {
        return reply.status(500).send({ error: 'Database error validating state' });
      }

      if (!userId) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            `<html><body style="font-family:sans-serif;padding:2rem">
            <h2>❌ Enlace expirado o inválido</h2>
            <p>Este enlace de autorización ya fue usado o expiró (tienen validez de 10 minutos).</p>
            <p>Por favor, solicita un nuevo enlace desde el bot de Telegram con el comando <b>/actualizar</b>.</p>
            </body></html>`,
          );
      }

      try {
        const tokenJson = await exchangeCodeForTokens(oauthClient, code);
        const encryptedToken = encrypt(tokenJson);
        await saveDriveOAuthToken(userId, encryptedToken);
        logger.info({ component: 'oauth', userId }, 'Drive OAuth token saved for user');
        return reply.type('text/html').send(
          `<html><body style="font-family:sans-serif;padding:2rem">
                    <h2>✅ Google Drive autorizado correctamente</h2>
                    <p>Ya puedes cerrar esta ventana. El bot comenzará a subir archivos a tu Drive.</p>
                    </body></html>`,
        );
      } catch (err) {
        logger.error(
          { component: 'oauth', userId, error: String(err) },
          'Failed to exchange OAuth code',
        );
        return reply.status(500).send({ error: 'Token exchange failed', detail: String(err) });
      }
    },
  );

  // Utility: GET /auth/drive/url?userId=<uuid>  → returns the auth URL as JSON (for CLI/scripts)
  fastify.get<{ Querystring: { userId?: string } }>('/auth/drive/url', async (request, reply) => {
    if (!oauthClient) {
      return reply.status(503).send({ error: 'OAuth client not configured' });
    }
    const { userId } = request.query;
    if (!userId) return reply.status(400).send({ error: 'Missing userId query param' });
    const state = await createOAuthState(userId);
    const authUrl = getAuthorizationUrl(oauthClient, state);
    return { authUrl };
  });

  // ─── OneDrive OAuth flow ───────────────────────────────────────────────────
  fastify.get<{ Querystring: { userId?: string } }>('/auth/onedrive', async (request, reply) => {
    if (!onedriveClient) {
      return reply
        .status(503)
        .send({ error: 'OAuth client not configured (ONEDRIVE_CLIENT_ID missing)' });
    }
    const { userId } = request.query;
    if (!userId) return reply.status(400).send({ error: 'Missing userId query param' });

    const state = await createOAuthState(userId);
    const authUrl = getOneDriveAuthorizationUrl(onedriveClient, state);
    return reply.redirect(authUrl);
  });

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/onedrive/callback',
    async (request, reply) => {
      if (!onedriveClient) {
        return reply.status(503).send({ error: 'OAuth client not configured' });
      }
      const { code, state, error } = request.query;
      if (error) return reply.status(400).send({ error: `Microsoft returned: ${error}` });
      if (!code || !state) return reply.status(400).send({ error: 'Missing code or state' });

      let userId: string | null;
      try {
        userId = await consumeOAuthState(state);
      } catch (err) {
        return reply.status(500).send({ error: 'Database error validating state' });
      }

      if (!userId) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            `<html><body style="font-family:sans-serif;padding:2rem">
            <h2>❌ Enlace expirado o inválido</h2>
            <p>Este enlace de autorización ya fue usado o expiró (tienen validez de 10 minutos).</p>
            <p>Por favor, solicita un nuevo enlace desde el bot de Telegram con el comando <b>/almacenamiento</b>.</p>
            </body></html>`,
          );
      }

      try {
        const tokenJson = await exchangeOneDriveCodeForTokens(onedriveClient, code);
        const encryptedToken = encrypt(tokenJson);
        await saveOneDriveOAuthToken(userId, encryptedToken);
        logger.info({ component: 'oauth', userId }, 'OneDrive OAuth token saved for user');
        return reply.type('text/html').send(
          `<html><body style="font-family:sans-serif;padding:2rem">
                    <h2>✅ OneDrive autorizado correctamente</h2>
                    <p>Ya puedes cerrar esta ventana. El bot comenzará a subir archivos a tu OneDrive.</p>
                    </body></html>`,
        );
      } catch (err) {
        logger.error(
          { component: 'oauth', userId, error: String(err) },
          'Failed to exchange OneDrive OAuth code',
        );
        return reply.status(500).send({ error: 'Token exchange failed', detail: String(err) });
      }
    },
  );

  fastify.get<{ Querystring: { userId?: string } }>(
    '/auth/onedrive/url',
    async (request, reply) => {
      if (!onedriveClient) {
        return reply.status(503).send({ error: 'OAuth client not configured' });
      }
      const { userId } = request.query;
      if (!userId) return reply.status(400).send({ error: 'Missing userId query param' });
      const state = await createOAuthState(userId);
      const authUrl = getOneDriveAuthorizationUrl(onedriveClient, state);
      return { authUrl };
    },
  );

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ component: 'core_startup', port: PORT }, 'Core listening');

  // Purge expired OAuth states every hour to prevent table bloat
  const OAUTH_PURGE_INTERVAL_MS = 60 * 60 * 1000;
  const oauthPurgeTimer = setInterval(() => {
    purgeExpiredOAuthStates()
      .then((deleted: number) => {
        if (deleted > 0) {
          logger.info({ component: 'core_oauth_purge', deleted }, 'Purged expired OAuth states');
        }
      })
      .catch((err: unknown) => {
        logger.warn({ component: 'core_oauth_purge', err }, 'Failed to purge OAuth states');
      });
  }, OAUTH_PURGE_INTERVAL_MS);

  let cycleTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;

  async function runCycle(): Promise<void> {
    try {
      await runOrchestrationCycle();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      logger.error(
        {
          component: 'core_cycle',
          consecutiveFailures,
          error: err instanceof Error ? err.message : String(err),
        },
        'Cycle threw unexpectedly — will retry with backoff',
      );
    }

    const delay = consecutiveFailures > 0
      ? Math.min(
          BASE_CYCLE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1),
          MAX_CYCLE_BACKOFF_MS,
        )
      : CYCLE_INTERVAL_MS;

    if (consecutiveFailures > 0) {
      logger.info(
        {
          component: 'core_cycle',
          delayMs: delay,
          consecutiveFailures,
        },
        'Scheduling next cycle with exponential backoff',
      );
    }

    cycleTimer = setTimeout(() => void runCycle(), delay);
  }

  logger.info(
    { component: 'core_startup', cycleIntervalMs: CYCLE_INTERVAL_MS },
    'Starting cycle loop',
  );
  logger.info({ component: 'core_startup' }, 'Running initial orchestration cycle');
  await runOrchestrationCycle();
  runCycle();

  const shutdown = async () => {
    if (cycleTimer !== null) clearTimeout(cycleTimer);
    clearInterval(oauthPurgeTimer);
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
