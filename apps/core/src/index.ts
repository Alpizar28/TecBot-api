import 'dotenv/config';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cron from 'node-cron';
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
const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '*/5 * * * *'; // Every 5 min

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
    logger.warn(
      { component: 'core_startup' },
      'INTERNAL_API_SECRET is not set — /api/run-now and /api/internal-dispatch are UNPROTECTED. Set this variable in production.',
    );
  }

  function requireInternalSecret(
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): boolean {
    if (!INTERNAL_API_SECRET) return true; // open only in dev; warn already logged above
    const provided = request.headers['x-internal-secret'];
    if (provided !== INTERNAL_API_SECRET) {
      void reply.status(401).send({ status: 'error', error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // Manual trigger for testing — requires x-internal-secret header
  fastify.post('/api/run-now', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;
    setImmediate(() => void runOrchestrationCycle());
    return { status: 'triggered' };
  });

  fastify.post<{
    Body: { userId: string; notification: RawNotification; cookies: ScrapeResponse['cookies'] };
  }>('/api/internal-dispatch', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;
    try {
      const { userId, notification, cookies } = request.body;
      const result = await handleInternalDispatch(userId, notification, cookies);
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

  if (!cron.validate(CRON_SCHEDULE)) {
    logger.error(
      { component: 'core_startup', cronSchedule: CRON_SCHEDULE },
      'Invalid CRON_SCHEDULE',
    );
    process.exit(1);
  }

  const job = cron.schedule(CRON_SCHEDULE, () => {
    logger.info(
      { component: 'core_cron', cronSchedule: CRON_SCHEDULE },
      'Running scheduled orchestration cycle',
    );
    void runOrchestrationCycle();
  });

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

  logger.info({ component: 'core_startup', cronSchedule: CRON_SCHEDULE }, 'Cron scheduled');
  logger.info({ component: 'core_startup' }, 'Running initial orchestration cycle');
  await runOrchestrationCycle();

  const shutdown = async () => {
    job.stop();
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
