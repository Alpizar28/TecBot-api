import 'dotenv/config';
import { Bot, session, type SessionFlavor, type Context } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { pino } from 'pino';
import {
  runMigrations,
  encrypt,
  decrypt,
  createUser,
  updateUser,
  getPendingRegistration,
  upsertPendingRegistration,
  upsertPendingRegistrationWithStep,
  advancePendingRegistration,
  deletePendingRegistration,
  getUserByTelegramChatId,
  getUserByTecUsername,
  createOAuthState,
  updateUserCredentials,
  updateUserDriveFolder,
  updateUserOneDriveFolder,
  updateUserStorageProvider,
  listUserNotificationCourses,
  listUserCourseFilters,
  muteUserCourse,
  unmuteUserCourses,
  resolveCourseEntry,
  getAdminStats,
  getLastCycleStats,
  getErrorSummary,
  countRecentErrors,
  getStudyosDeliveryStats,
  updateUserStudyos,
  clearUserStudyos,
  type RegistrationStep,
} from '@tec-brain/database';
import {
  loadOAuthClientConfig,
  loadOneDriveOAuthConfig,
  getAuthorizationUrl,
  getOneDriveAuthorizationUrl,
  type OAuthClient,
  type OneDriveOAuthClient,
} from '@tec-brain/drive';

// ─── Logger ───────────────────────────────────────────────────────────────────

const logger = pino({
  name: 'tec-brain-bot',
  level: process.env.LOG_LEVEL ?? 'info',
});

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  logger.fatal('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

// ─── Types ────────────────────────────────────────────────────────────────────

// We use a minimal session just to satisfy grammy's type system;
// real state lives in the DB (pending_registrations table).
interface SessionData {
  _: null;
  filtersPage: number;
}
type BotContext = Context & SessionFlavor<SessionData>;

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/** Minimum milliseconds between commands from the same chat. */
const RATE_LIMIT_WINDOW_MS = 3_000;
/** How often to sweep stale entries so the map does not grow unbounded. */
const RATE_LIMIT_PRUNE_INTERVAL_MS = 60_000;
const lastCommandAt = new Map<string, number>();
let lastPruneAt = 0;

/** Drops entries older than the rate-limit window; runs at most once per interval. */
function pruneRateLimiter(now: number): void {
  if (now - lastPruneAt < RATE_LIMIT_PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  for (const [chatId, ts] of lastCommandAt) {
    if (now - ts >= RATE_LIMIT_WINDOW_MS) lastCommandAt.delete(chatId);
  }
}

function isRateLimited(chatId: string): boolean {
  const now = Date.now();
  pruneRateLimiter(now);
  const last = lastCommandAt.get(chatId) ?? 0;
  if (now - last < RATE_LIMIT_WINDOW_MS) return true;
  lastCommandAt.set(chatId, now);
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extracts a Drive folder ID from a full Drive URL or returns the raw string if it looks like an ID already. */
function parseDriveFolderId(input: string): string | null {
  // Full URL: https://drive.google.com/drive/folders/<id>  or  /drive/u/0/folders/<id>
  const urlMatch = input.match(/folders\/([a-zA-Z0-9_-]{10,})/);
  if (urlMatch) return urlMatch[1];

  // Raw ID: only alphanumeric, underscores and dashes, 10+ chars
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input.trim())) return input.trim();

  return null;
}

/** Validates a TEC email address. */
function isTecEmail(value: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@(estudiantec\.cr|itcr\.ac\.cr|tec\.ac\.cr)$/i.test(value.trim());
}

function isValidOneDriveFolderId(value: string): boolean {
  return value.trim().length >= 6 && !value.trim().includes(' ');
}

/** Escapa texto arbitrario que se interpola en mensajes HTML de Telegram. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Normaliza una URL de StudyOS (https, sin slash final) o null si no es válida. */
function parseStudyosUrl(input: string): string | null {
  const raw = input.trim().replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Prueba URL+token contra GET /api/sync/ping antes de guardar nada.
 * Réplica mínima del pingStudyos del core — el bot no depende de apps/core.
 */
async function pingStudyosUrl(url: string, token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/api/sync/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface CourseFilterEntry {
  key: string;
  label: string;
  muted: boolean;
  legacyKeys: string[];
}

const FILTERS_PAGE_SIZE = 6;

function pickLongerLabel(a: string, b: string | undefined): string {
  if (!b) return a;
  return b.length > a.length ? b : a;
}

async function loadCourseFilterEntries(userId: string): Promise<{
  entries: CourseFilterEntry[];
  mutedCount: number;
}> {
  const notificationCourses = await listUserNotificationCourses(userId);
  const filters = await listUserCourseFilters(userId);
  const entries = new Map<string, CourseFilterEntry>();

  const resolvedCourses = await Promise.all(
    notificationCourses.map(async (course) => resolveCourseEntry(course)),
  );

  for (const resolved of resolvedCourses) {
    const legacyKeys = [resolved.legacyKey].filter((key) => key && key !== resolved.key);
    const existing = entries.get(resolved.key);
    if (existing) {
      existing.label = pickLongerLabel(existing.label, resolved.label);
      existing.legacyKeys = [...new Set([...existing.legacyKeys, ...legacyKeys])];
    } else {
      entries.set(resolved.key, {
        key: resolved.key,
        label: resolved.label,
        muted: false,
        legacyKeys,
      });
    }
  }

  for (const filter of filters) {
    const isLegacyKey = !filter.course_key.includes(':') && filter.course_key !== 'unknown';
    const resolved = isLegacyKey ? await resolveCourseEntry(filter.course_label) : null;
    const entryKey = resolved?.key ?? filter.course_key;
    const legacyKeys = [isLegacyKey ? filter.course_key : null, resolved?.legacyKey ?? null].filter(
      (key): key is string => !!key && key !== entryKey,
    );

    const existing = entries.get(entryKey);
    const labelCandidate = resolved?.label ?? filter.course_label;
    if (existing) {
      existing.label = pickLongerLabel(existing.label, labelCandidate);
      existing.legacyKeys = [...new Set([...existing.legacyKeys, ...legacyKeys])];
      existing.muted = true;
    } else {
      entries.set(entryKey, {
        key: entryKey,
        label: labelCandidate,
        muted: true,
        legacyKeys,
      });
    }
  }

  const sortedEntries = [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
  const mutedCount = sortedEntries.filter((entry) => entry.muted).length;
  return { entries: sortedEntries, mutedCount };
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  logger.info('Running database migrations');
  await runMigrations();
  logger.info('Migrations complete');

  // ─── OAuth client (optional — Drive integration) ───────────────────────────

  let oauthClient: OAuthClient | null = null;
  const oauthPath = process.env.GOOGLE_OAUTH_CLIENT_PATH;
  if (oauthPath) {
    try {
      oauthClient = loadOAuthClientConfig(oauthPath);
      logger.info('Google OAuth client loaded — Drive auth available');
    } catch (err) {
      logger.warn({ err }, 'Could not load Google OAuth client — Drive auth unavailable');
    }
  }

  let onedriveClient: OneDriveOAuthClient | null = null;
  try {
    onedriveClient = loadOneDriveOAuthConfig();
    logger.info('OneDrive OAuth client loaded — OneDrive auth available');
  } catch (err) {
    logger.warn({ err }, 'Could not load OneDrive OAuth client — OneDrive auth unavailable');
  }

  /** Builds the Google Drive auth URL for a user and returns it. */
  async function buildDriveAuthUrl(userId: string): Promise<string> {
    if (!oauthClient) throw new Error('OAuth client not configured');
    const state = await createOAuthState(userId);
    return getAuthorizationUrl(oauthClient, state);
  }

  async function buildOneDriveAuthUrl(userId: string): Promise<string> {
    if (!onedriveClient) throw new Error('OneDrive OAuth client not configured');
    const state = await createOAuthState(userId);
    return getOneDriveAuthorizationUrl(onedriveClient, state);
  }

  // ─── Bot setup — fresh instance every startup ──────────────────────────────

  const bot = new Bot<BotContext>(BOT_TOKEN as string);
  bot.use(session({ initial: (): SessionData => ({ _: null, filtersPage: 0 }) }));

  // ─── Menus ─────────────────────────────────────────────────────────────────

  // Confirmation Menu
  const confirmMenu = new Menu<BotContext>('confirm-menu')
    .text('✅ Sí, completar registro', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const pending = await getPendingRegistration(chatId);

      if (!pending || pending.step !== 'awaiting_confirmation') {
        await ctx.reply('La sesión ha expirado o ya se completó.');
        return;
      }

      if (!pending.tec_username || !pending.tec_password_enc) {
        await ctx.reply('❌ Faltan datos. Envía /start para comenzar de nuevo.');
        await deletePendingRegistration(chatId);
        return;
      }

      // Derive a display name from the email (e.g. "juan.perez.1@estudiantec.cr" → "Juan Perez")
      const namePart = pending.tec_username.split('@')[0];
      const displayName = namePart
        .split('.')
        .filter((p: string) => !/^\d+$/.test(p)) // strip trailing numbers
        .map((p: string) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');

      let userId: string;
      try {
        const existingUser = await getUserByTelegramChatId(chatId);
        if (existingUser) {
          // User is updating their info via /actualizar
          userId = await updateUser(chatId, {
            tec_username: pending.tec_username,
            tec_password_enc: pending.tec_password_enc,
            drive_root_folder_id: pending.drive_folder_id ?? null,
            storage_provider: pending.drive_folder_id ? 'drive' : 'none',
          });
        } else {
          // Brand new user
          userId = await createUser({
            name: displayName,
            tec_username: pending.tec_username,
            tec_password_enc: pending.tec_password_enc,
            telegram_chat_id: chatId,
            drive_root_folder_id: pending.drive_folder_id ?? null,
            storage_provider: pending.drive_folder_id ? 'drive' : 'none',
          });
        }
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to save user during registration');
        await ctx.editMessageText(
          '❌ Hubo un error al guardar tu cuenta. Si el correo ya estaba registrado, asegúrate de usar /actualizar. De lo contrario, intenta de nuevo.',
        );
        return;
      }

      await deletePendingRegistration(chatId);

      logger.info(
        { chatId, userId, username: pending.tec_username },
        'User registered/updated via bot',
      );

      // ── Drive OAuth ───────────────────────────────────────────────────────────
      if (pending.drive_folder_id && oauthClient) {
        let driveUrl: string;
        try {
          driveUrl = await buildDriveAuthUrl(userId);
        } catch (err) {
          logger.warn({ err, userId }, 'Could not build Drive auth URL');
          await ctx.editMessageText(
            `🎉 <b>¡Registro completado!</b>\n\n` +
              `Ya estás configurado y comenzarás a recibir notificaciones de TEC Digital en los próximos minutos.\n\n` +
              `⚠️ No se pudo generar el link de Google Drive. Contacta al administrador para activarlo.`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        await ctx.editMessageText(
          `🎉 <b>¡Registro completado!</b>\n\n` +
            `✅ Ya estás en el sistema.\n\n` +
            `─────────────────────\n` +
            `📁 <b>Último paso — Autorizar Google Drive</b>\n\n` +
            `Para que el bot pueda subir tus archivos a Drive, necesitas autorizarlo una sola vez:\n\n` +
            `👉 <a href="${driveUrl.replace(/&/g, '&amp;')}">Toca aquí para autorizar Google Drive</a>\n\n` +
            `<i>Se abrirá una página de Google. Selecciona tu cuenta y acepta los permisos.</i>\n\n` +
            `Si no quieres Drive ahora, puedes ignorar este paso. Recibirás los archivos igualmente con enlaces directos.`,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      } else {
        await ctx.editMessageText(
          `🎉 <b>¡Registro completado, ${displayName}!</b>\n\n` +
            `✅ En los próximos minutos comenzarás a recibir tus notificaciones de TEC Digital aquí en Telegram.\n\n` +
            `─────────────────────\n` +
            `<b>Comandos disponibles:</b>\n` +
            `/estado — Ver el estado de tu cuenta\n` +
            `/cancelar — Reiniciar el registro`,
          { parse_mode: 'HTML' },
        );
      }
    })
    .row()
    .text('❌ No, cancelar y volver a empezar', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await upsertPendingRegistration(chatId);
      await ctx.editMessageText('🔄 Registro cancelado.');
      await ctx.reply(
        'Empecemos de nuevo.\n\n' +
          '📧 <b>Paso 1 de 3</b>\n' +
          '¿Cuál es tu correo institucional del TEC?',
        { parse_mode: 'HTML' },
      );
    });

  // Drive Skip Menu
  const skipDriveMenu = new Menu<BotContext>('skip-drive-menu').text(
    '⏭️ Omitir (No usar Google Drive)',
    async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await advancePendingRegistration(chatId, 'awaiting_confirmation', {
        drive_folder_id: null,
      });

      const reg = await getPendingRegistration(chatId);

      await ctx.editMessageText(
        `📋 <b>Resumen de tu registro</b>\n\n` +
          `📧 <b>Correo TEC:</b> <code>${reg?.tec_username ?? '?'}</code>\n` +
          `🔑 <b>Contraseña:</b> <code>••••••••</code> (cifrada)\n` +
          `📁 <b>Carpeta Drive:</b> ❌ Sin Drive (solo Telegram)\n\n` +
          `─────────────────────\n` +
          `¿Todo está bien?`,
        { parse_mode: 'HTML', reply_markup: confirmMenu },
      );
    },
  );

  const updateMenu = new Menu<BotContext>('update-menu')
    .text('🔐 Credenciales TEC', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await upsertPendingRegistrationWithStep(chatId, 'update_awaiting_username');
      await ctx.editMessageText(
        `🔄 <b>Actualización de Credenciales</b>\n\n` +
          `¿Cuál es tu nuevo correo institucional del TEC?\n\n` +
          `<i>Ejemplo: tu.nombre@estudiantec.cr</i>`,
        { parse_mode: 'HTML' },
      );
    })
    .row()
    .text('📁 Carpeta Drive', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await upsertPendingRegistrationWithStep(chatId, 'update_awaiting_drive');
      await ctx.editMessageText(
        `📁 <b>Actualización de Carpeta Drive</b>\n\n` +
          `Por favor, envía el nuevo ID o enlace de la carpeta de Google Drive que deseas usar.\n` +
          `Si deseas dejar de usar Drive, envía la palabra <b>"no"</b>.`,
        { parse_mode: 'HTML' },
      );
    })
    .row()
    .text('🔄 Actualizar Todo', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await upsertPendingRegistrationWithStep(chatId, 'awaiting_username');
      await ctx.editMessageText(
        `🔄 <b>Actualización Completa</b>\n\n` +
          `Vamos a actualizar todos tus datos.\n\n` +
          `📧 <b>Paso 1 de 3</b>\n` +
          `¿Cuál es tu correo institucional del TEC?\n\n` +
          `<i>Ejemplo: tu.nombre@estudiantec.cr</i>`,
        { parse_mode: 'HTML' },
      );
    });

  const storageMenu = new Menu<BotContext>('storage-menu')
    .text('📁 Google Drive', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await upsertPendingRegistrationWithStep(chatId, 'storage_awaiting_drive_folder');
      await ctx.editMessageText(
        `📁 <b>Configurar Google Drive</b>\n\n` +
          `Envíame el ID o enlace de la carpeta raíz de Google Drive que quieres usar.\n` +
          `<i>Ejemplo: drive.google.com/drive/folders/1AbcXyz...</i>`,
        { parse_mode: 'HTML' },
      );
    })
    .row()
    .text('☁️ OneDrive', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await upsertPendingRegistrationWithStep(chatId, 'storage_awaiting_onedrive_folder');
      await ctx.editMessageText(
        `☁️ <b>Configurar OneDrive</b>\n\n` +
          `Envíame el <b>ID</b> de la carpeta raíz de OneDrive que quieres usar.\n` +
          `<i>Ejemplo: 01ABCDXYZ...</i>`,
        { parse_mode: 'HTML' },
      );
    })
    .row()
    .text('🚫 Sin almacenamiento', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await updateUserStorageProvider(chatId, 'none');
      await deletePendingRegistration(chatId);
      await ctx.editMessageText('✅ Almacenamiento desactivado. Solo recibirás Telegram.');
    });

  const studyosMenu = new Menu<BotContext>('studyos-menu')
    .text('🔄 Reconfigurar', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await upsertPendingRegistrationWithStep(chatId, 'studyos_awaiting_url');
      await ctx.editMessageText(
        `🔗 <b>Conectar StudyOS</b>\n\n` +
          `Envíame la <b>URL</b> de tu instancia de StudyOS.\n\n` +
          `<i>Ejemplo: https://study.alpizar.dev</i>`,
        { parse_mode: 'HTML' },
      );
    })
    .row()
    .text('🔌 Desconectar', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      await clearUserStudyos(chatId);
      await ctx.editMessageText(
        '✅ StudyOS desconectado. Tus notificaciones ya no se enviarán ahí.\n' +
          'Podés reconectarlo cuando quieras con /studyos.',
      );
    });

  bot.use(confirmMenu);
  bot.use(skipDriveMenu);
  bot.use(updateMenu);
  bot.use(storageMenu);
  bot.use(studyosMenu);

  // ─── Filters Menu ──────────────────────────────────────────────────────────

  const filtersMenu = new Menu<BotContext>('filters-menu').dynamic(async (ctx, range) => {
    const chatId = String(ctx.chat?.id);
    const user = await getUserByTelegramChatId(chatId);
    if (!user) {
      range.text('❌ No registrado', async (ctx) => {
        await ctx.answerCallbackQuery('Envía /start para registrarte.');
      });
      return;
    }

    const { entries } = await loadCourseFilterEntries(user.id);
    if (entries.length === 0) {
      range.text('Sin cursos', async (ctx) => {
        await ctx.answerCallbackQuery('Aún no hay cursos para filtrar.');
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(entries.length / FILTERS_PAGE_SIZE));
    const page = Math.min(ctx.session.filtersPage, totalPages - 1);
    ctx.session.filtersPage = page;

    const pageEntries = entries.slice(
      page * FILTERS_PAGE_SIZE,
      page * FILTERS_PAGE_SIZE + FILTERS_PAGE_SIZE,
    );

    for (const entry of pageEntries) {
      const label = entry.muted ? `🔇 ${entry.label}` : `🔔 ${entry.label}`;
      const courseKey = entry.key;
      const courseLabel = entry.label;
      const isMuted = entry.muted;
      const legacyKeys = entry.legacyKeys;

      range.text(label, async (ctx) => {
        const chatId = String(ctx.chat?.id);
        const user = await getUserByTelegramChatId(chatId);
        if (!user) {
          await ctx.answerCallbackQuery('No estás registrado.');
          return;
        }

        if (isMuted) {
          const keysToClear = [courseKey, ...legacyKeys].filter(
            (key, index, arr) => key && arr.indexOf(key) === index,
          );
          await unmuteUserCourses(user.id, keysToClear);
          await ctx.answerCallbackQuery('Curso activado');
        } else {
          await muteUserCourse(user.id, courseKey, courseLabel);
          await ctx.answerCallbackQuery('Curso silenciado');
        }

        await ctx.menu.update();
      });
      range.row();
    }

    if (totalPages > 1) {
      range.text('⬅️', async (ctx) => {
        ctx.session.filtersPage = Math.max(0, page - 1);
        await ctx.menu.update();
      });
      range.text(`${page + 1}/${totalPages}`, async (ctx) => {
        await ctx.answerCallbackQuery(`Página ${page + 1} de ${totalPages}`);
      });
      range.text('➡️', async (ctx) => {
        ctx.session.filtersPage = Math.min(totalPages - 1, page + 1);
        await ctx.menu.update();
      });
    }
  });

  bot.use(filtersMenu);

  // ─── /start ─────────────────────────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    const existingUser = await getUserByTelegramChatId(chatId);

    if (existingUser) {
      await ctx.reply(
        `👋 ¡Hola de nuevo, <b>${existingUser.name}</b>!\n\n` +
          `Veo que ya estás registrado en el sistema con el correo <code>${existingUser.tec_username}</code>.\n\n` +
          `Si deseas actualizar tu contraseña o tu carpeta de Google Drive, envía el comando /actualizar.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await upsertPendingRegistration(chatId);

    await ctx.reply(
      `👋 ¡Hola! Soy el <b>TEC Brain Bot</b>.\n\n` +
        `Te voy a configurar para recibir las notificaciones de <b>TEC Digital</b> directamente aquí en Telegram.\n\n` +
        `Este proceso toma menos de 2 minutos.\n\n` +
        `─────────────────────\n` +
        `📧 <b>Paso 1 de 3</b>\n` +
        `¿Cuál es tu correo institucional del TEC?\n\n` +
        `<i>Ejemplo: tu.nombre@estudiantec.cr</i>`,
      { parse_mode: 'HTML' },
    );
    logger.info({ chatId }, '/start — registration reset, awaiting_username');
  });

  // ─── /actualizar ────────────────────────────────────────────────────────────

  bot.command('actualizar', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    const existingUser = await getUserByTelegramChatId(chatId);

    if (!existingUser) {
      await ctx.reply('❌ No tienes una cuenta registrada. Envía /start para comenzar.');
      return;
    }

    await ctx.reply(
      `🔄 <b>Opciones de Actualización</b>\n\n` + `Selecciona qué deseas actualizar:`,
      {
        parse_mode: 'HTML',
        reply_markup: updateMenu,
      },
    );
    logger.info({ chatId }, '/actualizar — showing update menu');
  });

  // ─── /cancelar ──────────────────────────────────────────────────────────────

  bot.command('cancelar', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    await deletePendingRegistration(chatId);
    await ctx.reply('❌ Registro cancelado. Envía /start cuando quieras intentarlo de nuevo.', {
      parse_mode: 'HTML',
    });
  });

  // ─── /estado ────────────────────────────────────────────────────────────────

  bot.command('estado', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    const pending = await getPendingRegistration(chatId);

    if (!pending || pending.step === 'done') {
      const user = await getUserByTelegramChatId(chatId);
      const providerLabel =
        user?.storage_provider === 'drive'
          ? 'Google Drive'
          : user?.storage_provider === 'onedrive'
            ? 'OneDrive'
            : 'Sin almacenamiento';
      const storageDetail =
        user?.storage_provider === 'drive'
          ? user.drive_root_folder_id
            ? `\n📁 <b>Drive:</b> <code>${user.drive_root_folder_id}</code>`
            : ''
          : user?.storage_provider === 'onedrive'
            ? user.onedrive_root_folder_id
              ? `\n☁️ <b>OneDrive:</b> <code>${user.onedrive_root_folder_id}</code>`
              : ''
            : '';
      await ctx.reply(
        '✅ Ya estás registrado y recibiendo notificaciones.\n\n' +
          `📦 <b>Almacenamiento:</b> ${providerLabel}${storageDetail}\n\n` +
          'Si necesitas actualizar tus datos, envía /actualizar para modificar tu configuración.\n' +
          'Para cambiar almacenamiento, usa /almacenamiento.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const stepLabels: Record<RegistrationStep, string> = {
      awaiting_username: 'Esperando tu correo del TEC',
      awaiting_password: 'Esperando tu contraseña del TEC',
      awaiting_drive_folder: 'Esperando la carpeta de Google Drive',
      awaiting_confirmation: 'Esperando confirmación final',
      done: 'Registro completado',
      update_awaiting_username: 'Actualizando tu correo del TEC',
      update_awaiting_password: 'Actualizando tu contraseña del TEC',
      update_awaiting_drive: 'Actualizando la carpeta de Google Drive',
      storage_awaiting_drive_folder: 'Configurando Google Drive',
      storage_awaiting_onedrive_folder: 'Configurando OneDrive',
      studyos_awaiting_url: 'Conectando StudyOS (esperando URL)',
      studyos_awaiting_token: 'Conectando StudyOS (esperando token)',
    };

    await ctx.reply(
      `🔄 Tienes un registro en progreso.\n\n` +
        `<b>Estado actual:</b> ${stepLabels[pending.step]}\n\n` +
        `Continúa respondiendo a las preguntas anteriores, o envía /cancelar para empezar de nuevo.`,
      { parse_mode: 'HTML' },
    );
  });

  // ─── /almacenamiento ───────────────────────────────────────────────────────

  bot.command('almacenamiento', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    const user = await getUserByTelegramChatId(chatId);

    if (!user) {
      await ctx.reply('❌ No tienes una cuenta registrada. Envía /start para comenzar.');
      return;
    }

    const pending = await getPendingRegistration(chatId);
    if (pending && pending.step !== 'done') {
      await ctx.reply(
        '⚠️ Tienes un registro en progreso. Completa ese flujo o envía /cancelar antes de cambiar almacenamiento.',
      );
      return;
    }

    const providerLabel =
      user.storage_provider === 'drive'
        ? 'Google Drive'
        : user.storage_provider === 'onedrive'
          ? 'OneDrive'
          : 'Sin almacenamiento';

    await ctx.reply(
      `📦 <b>Almacenamiento actual:</b> ${providerLabel}\n\n` +
        'Elige dónde quieres guardar los documentos:',
      { parse_mode: 'HTML', reply_markup: storageMenu },
    );
  });

  // ─── /studyos ───────────────────────────────────────────────────────────────
  // Conectar/ver la integración con StudyOS: estado de entregas + ping en
  // vivo si ya está configurada, o flujo guiado URL → token con prueba de
  // conexión real antes de guardar (token cifrado, nunca en texto plano).

  bot.command('studyos', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    const user = await getUserByTelegramChatId(chatId);

    if (!user) {
      await ctx.reply('❌ No tienes una cuenta registrada. Envía /start para comenzar.');
      return;
    }

    const pending = await getPendingRegistration(chatId);
    if (pending && pending.step !== 'done' && !pending.step.startsWith('studyos_')) {
      await ctx.reply(
        '⚠️ Tienes un registro en progreso. Completa ese flujo o envía /cancelar antes de configurar StudyOS.',
      );
      return;
    }

    if (!user.studyos_url || !user.studyos_token_enc) {
      await upsertPendingRegistrationWithStep(chatId, 'studyos_awaiting_url');
      await ctx.reply(
        `🔗 <b>Conectar StudyOS</b>\n\n` +
          `Tus notificaciones de TEC Digital pueden sincronizarse a una instancia de StudyOS.\n\n` +
          `📍 <b>Paso 1 de 2</b>\n` +
          `Envíame la <b>URL</b> de tu instancia.\n\n` +
          `<i>Ejemplo: https://study.alpizar.dev</i>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Ya configurado: estado en vivo.
    let pingLine = '⏳ Probando conexión…';
    try {
      const ping = await pingStudyosUrl(user.studyos_url, decrypt(user.studyos_token_enc));
      pingLine = ping.ok
        ? '🟢 <b>Conexión:</b> OK'
        : `🔴 <b>Conexión:</b> falla (<code>${escapeHtml(ping.error ?? 'desconocido')}</code>)`;
    } catch {
      pingLine = '🔴 <b>Conexión:</b> no se pudo descifrar el token — reconfigura.';
    }

    const stats = await getStudyosDeliveryStats(user.id).catch(() => null);
    const statsLines = stats
      ? [
          `📬 <b>Entregadas últimas 24 h:</b> ${stats.delivered_24h}`,
          `⏳ <b>Pendientes de reintento:</b> ${stats.pending}`,
          ...(stats.failed_permanent > 0
            ? [`🚫 <b>Descartadas (error definitivo):</b> ${stats.failed_permanent}`]
            : []),
          ...(stats.last_error
            ? [`⚠️ <b>Último error:</b> <code>${escapeHtml(stats.last_error.slice(0, 120))}</code>`]
            : []),
        ]
      : ['⚠️ No pude leer las estadísticas de entrega.'];

    await ctx.reply(
      [
        `🔗 <b>StudyOS</b>`,
        ``,
        `🌐 <b>URL:</b> ${user.studyos_url}`,
        pingLine,
        ``,
        ...statsLines,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: studyosMenu },
    );
  });

  // ─── /filtros ───────────────────────────────────────────────────────────────

  bot.command('filtros', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    const user = await getUserByTelegramChatId(chatId);

    if (!user) {
      await ctx.reply('❌ No tienes una cuenta registrada. Envía /start para comenzar.');
      return;
    }

    const { entries, mutedCount } = await loadCourseFilterEntries(user.id);
    if (entries.length === 0) {
      await ctx.reply(
        'Aún no tengo cursos o comunidades con notificaciones para mostrar.\n\n' +
          'Cuando llegue la primera notificación, podrás silenciarla desde aquí.',
      );
      return;
    }

    ctx.session.filtersPage = 0;
    await ctx.reply(
      `🎛️ <b>Filtros de cursos y comunidades</b>\n\n` +
        `🔇 Silenciados: <b>${mutedCount}</b>\n` +
        `📚 Total: <b>${entries.length}</b>\n\n` +
        `Toca un curso para silenciarlo o activarlo.\n` +
        `<i>Se muestran cursos detectados y los que ya silenciaste.</i>`,
      { parse_mode: 'HTML', reply_markup: filtersMenu },
    );
  });

  // ─── Message handler — main conversation flow ──────────────────────────────

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) return;
    const text = ctx.message.text.trim();

    // Ignore commands (already handled above)
    if (text.startsWith('/')) return;

    const pending = await getPendingRegistration(chatId);

    if (!pending || pending.step === 'done') {
      await ctx.reply('Envía /start para registrarte y comenzar a recibir notificaciones del TEC.');
      return;
    }

    // ── Step 1: TEC username ──────────────────────────────────────────────────
    if (pending.step === 'awaiting_username' || pending.step === 'update_awaiting_username') {
      const email = text.toLowerCase().trim();

      if (!isTecEmail(email)) {
        await ctx.reply(
          '⚠️ Ese no parece ser un correo institucional del TEC.\n\n' +
            'Debe terminar en <code>@estudiantec.cr</code>.\n\n' +
            '<i>Ejemplo: juan.perez.1@estudiantec.cr</i>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const userWithEmail = await getUserByTecUsername(email);
      if (userWithEmail && userWithEmail.telegram_chat_id !== chatId) {
        await ctx.reply(
          '⚠️ Este correo ya está registrado por otro usuario.\n\n' +
            'Si es tuyo y quieres moverlo aquí, contacta al administrador.',
        );
        return;
      }

      const nextStep =
        pending.step === 'update_awaiting_username'
          ? 'update_awaiting_password'
          : 'awaiting_password';

      await advancePendingRegistration(chatId, nextStep, {
        tec_username: email,
      });

      await ctx.reply(
        `✅ Correo guardado: <code>${email}</code>\n\n` +
          `─────────────────────\n` +
          `🔑 <b>Paso 2</b>\n` +
          `¿Cuál es tu contraseña del TEC Digital?\n\n` +
          `<i>🔒 Se guardará cifrada y el bot la borrará de este chat inmediatamente por seguridad.</i>\n\n` +
          `⚠️ <b>Después de que la envíes, borra el mensaje</b> por seguridad.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // ── Step 2: TEC password ──────────────────────────────────────────────────
    if (pending.step === 'awaiting_password' || pending.step === 'update_awaiting_password') {
      if (text.length < 4) {
        await ctx.reply('⚠️ La contraseña parece muy corta. Inténtalo de nuevo.');
        return;
      }

      const encryptedPwd = encrypt(text);

      if (pending.step === 'update_awaiting_password') {
        // Just update the credentials and finish
        const userWithEmail = await getUserByTelegramChatId(chatId);
        if (!userWithEmail) {
          // Fallback in case user does not exist
          await ctx.reply('❌ No se encontró tu usuario. Por favor, empieza con /start.');
          return;
        }

        const emailToSave = pending.tec_username ?? userWithEmail.tec_username;
        await updateUserCredentials(chatId, emailToSave, encryptedPwd);
        await deletePendingRegistration(chatId);

        await ctx.reply(
          `✅ <b>Credenciales actualizadas correctamente.</b>\n\n` +
            `A partir de ahora usaré tus nuevas credenciales para obtener notificaciones.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      await advancePendingRegistration(chatId, 'awaiting_drive_folder', {
        tec_password_enc: encryptedPwd,
      });

      await ctx.reply(
        `✅ Contraseña guardada de forma segura.\n\n` +
          `─────────────────────\n` +
          `📁 <b>Paso 3 de 3</b>\n` +
          `¿Quieres que el bot suba tus archivos y documentos a <b>Google Drive</b>?\n\n` +
          `Si <b>sí</b>:\n` +
          `1. Abre Google Drive y crea una carpeta (ej: <i>"Universidad"</i>).\n` +
          `2. Entra a esa carpeta y copia el <b>ID</b> que aparece en la URL:\n` +
          `   <code>drive.google.com/drive/folders/<b>ESTE_ES_EL_ID</b></code>\n` +
          `3. Pégalo aquí en el chat.\n\n` +
          `Si <b>no</b> quieres usar Drive, presiona el botón de abajo:`,
        { parse_mode: 'HTML', reply_markup: skipDriveMenu },
      );
      return;
    }

    // ── Step 3: Drive folder ──────────────────────────────────────────────────
    if (
      pending.step === 'awaiting_drive_folder' ||
      pending.step === 'update_awaiting_drive' ||
      pending.step === 'storage_awaiting_drive_folder'
    ) {
      let folderId: string | null = null;

      if (text.toLowerCase() !== 'no') {
        folderId = parseDriveFolderId(text);
        if (!folderId) {
          await ctx.reply(
            '⚠️ No pude identificar un ID de carpeta de Google Drive en lo que enviaste.\n\n' +
              '• Copia el ID directamente de la URL de Drive:\n' +
              '  <code>drive.google.com/drive/folders/<b>1AbcXyz...</b></code>\n\n' +
              '• O presiona el botón para omitir Drive.',
            {
              parse_mode: 'HTML',
              reply_markup: pending.step === 'awaiting_drive_folder' ? skipDriveMenu : undefined,
            },
          );
          return;
        }
      }

      if (
        pending.step === 'update_awaiting_drive' ||
        pending.step === 'storage_awaiting_drive_folder'
      ) {
        // Just update the drive folder and finish
        const userWithEmail = await getUserByTelegramChatId(chatId);
        if (!userWithEmail) {
          await ctx.reply('❌ No se encontró tu usuario. Por favor, empieza con /start.');
          return;
        }

        await updateUserDriveFolder(chatId, folderId);
        await updateUserStorageProvider(chatId, folderId ? 'drive' : 'none');
        await deletePendingRegistration(chatId);

        const driveText = folderId
          ? `✅ ID: <code>${folderId}</code>`
          : '❌ Sin Drive (solo Telegram)';
        let authMessage = '';

        if (folderId) {
          try {
            const driveUrl = await buildDriveAuthUrl(userWithEmail.id);
            authMessage =
              `\n\n⚠️ <b>¡Importante!</b> Debes volver a autorizar tu cuenta de Google Drive para la nueva carpeta.\n\n` +
              `👉 <a href="${driveUrl.replace(/&/g, '&amp;')}">Toca aquí para autorizar Google Drive</a>`;
          } catch (err) {
            authMessage = `\n\n⚠️ No pude generar el link de autorización de Drive. Contacta al administrador.`;
          }
        }

        await ctx.reply(
          `✅ <b>Carpeta de Drive actualizada.</b>\n\n` +
            `📁 <b>Nueva Carpeta:</b> ${driveText}${authMessage}`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      await advancePendingRegistration(chatId, 'awaiting_confirmation', {
        drive_folder_id: folderId,
      });

      // Re-fetch to get all data for the summary
      const reg = await getPendingRegistration(chatId);
      const driveText = folderId ? `✅ <code>${folderId}</code>` : '❌ Sin Drive (solo Telegram)';

      await ctx.reply(
        `📋 <b>Resumen de tu registro</b>\n\n` +
          `📧 <b>Correo TEC:</b> <code>${reg?.tec_username ?? '?'}</code>\n` +
          `🔑 <b>Contraseña:</b> <code>••••••••</code> (cifrada)\n` +
          `📁 <b>Carpeta Drive:</b> ${driveText}\n\n` +
          `─────────────────────\n` +
          `¿Todo está bien?`,
        { parse_mode: 'HTML', reply_markup: confirmMenu },
      );
      return;
    }

    if (pending.step === 'storage_awaiting_onedrive_folder') {
      const folderId = text.trim();
      if (!isValidOneDriveFolderId(folderId)) {
        await ctx.reply(
          '⚠️ Ese ID no parece válido. Copia el ID de carpeta de OneDrive y envíalo de nuevo.',
        );
        return;
      }

      const user = await getUserByTelegramChatId(chatId);
      if (!user) {
        await ctx.reply('❌ No se encontró tu usuario. Por favor, empieza con /start.');
        return;
      }

      await updateUserOneDriveFolder(chatId, folderId);
      await updateUserStorageProvider(chatId, 'onedrive');
      await deletePendingRegistration(chatId);

      let authMessage = '';
      try {
        const oneDriveUrl = await buildOneDriveAuthUrl(user.id);
        authMessage = `\n\n👉 <a href="${oneDriveUrl.replace(/&/g, '&amp;')}">Toca aquí para autorizar OneDrive</a>`;
      } catch (err) {
        authMessage = `\n\n⚠️ No pude generar el link de autorización de OneDrive. Contacta al administrador.`;
      }

      await ctx.reply(
        `✅ <b>OneDrive configurado.</b>\n\n` +
          `☁️ <b>Carpeta:</b> <code>${folderId}</code>${authMessage}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // ── StudyOS: URL ──────────────────────────────────────────────────────────
    if (pending.step === 'studyos_awaiting_url') {
      const url = parseStudyosUrl(text);
      if (!url) {
        await ctx.reply(
          '⚠️ Esa no parece una URL válida (debe empezar con <code>https://</code>).\n\n' +
            '<i>Ejemplo: https://study.alpizar.dev</i>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      await advancePendingRegistration(chatId, 'studyos_awaiting_token', { studyos_url: url });
      await ctx.reply(
        `✅ URL guardada: <code>${url}</code>\n\n` +
          `🔑 <b>Paso 2 de 2</b>\n` +
          `Envíame el <b>token de sync</b> de esa instancia (env <code>STUDYOS_SYNC_TOKEN</code>).\n\n` +
          `<i>🔒 Se guardará cifrado. Después de enviarlo, borra el mensaje por seguridad.</i>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // ── StudyOS: token (se prueba la conexión antes de guardar) ───────────────
    if (pending.step === 'studyos_awaiting_token') {
      const token = text.trim();
      if (token.length < 16 || /\s/.test(token)) {
        await ctx.reply('⚠️ Ese token parece inválido (muy corto o con espacios). Inténtalo de nuevo.');
        return;
      }
      if (!pending.studyos_url) {
        await deletePendingRegistration(chatId);
        await ctx.reply('❌ Se perdió la URL del paso anterior. Empieza de nuevo con /studyos.');
        return;
      }

      await ctx.reply('⏳ Probando la conexión…');
      const ping = await pingStudyosUrl(pending.studyos_url, token);
      if (!ping.ok) {
        await ctx.reply(
          `🔴 No pude conectarme a <code>${pending.studyos_url}</code>:\n` +
            `<code>${escapeHtml(ping.error ?? 'error desconocido')}</code>\n\n` +
            `Revisa que la URL sea correcta y que el token coincida con el ` +
            `<code>STUDYOS_SYNC_TOKEN</code> de esa instancia. Envía el token de nuevo, ` +
            `o /cancelar para salir.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      await updateUserStudyos(chatId, pending.studyos_url, encrypt(token));
      await deletePendingRegistration(chatId);
      await ctx.reply(
        `🎉 <b>StudyOS conectado.</b>\n\n` +
          `🌐 <code>${pending.studyos_url}</code>\n` +
          `🟢 Conexión verificada.\n\n` +
          `Tus notificaciones nuevas se sincronizarán a partir del próximo ciclo ` +
          `(y las de los últimos 14 días que estén pendientes también). ` +
          `Estado en cualquier momento: /studyos.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // ── Step 4: Confirmation (fallback if typed) ──────────────────────────────
    if (pending.step === 'awaiting_confirmation') {
      await ctx.reply(
        'Por favor, usa los botones de arriba para confirmar o cancelar el registro.',
        {
          reply_markup: confirmMenu,
        },
      );
      return;
    }
  });

  // ─── /admin ─────────────────────────────────────────────────────────────────

  const ADMIN_CHAT_ID = process.env.ADMIN_ALERT_CHAT_ID?.trim().replace(/^["']|["']$/g, '');
  if (!ADMIN_CHAT_ID) {
    logger.warn('ADMIN_ALERT_CHAT_ID is not set — /admin command is disabled');
  } else {
    logger.info({ adminChatId: ADMIN_CHAT_ID }, '/admin command enabled');
  }

  bot.command('admin', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!ADMIN_CHAT_ID || chatId !== ADMIN_CHAT_ID) return;

    try {
      const stats = await getAdminStats();
      const { activeUsers, storageBreakdown, totalNotifications, totalUploadedFiles } = stats;

      await ctx.reply(
        `🛡️ <b>Panel de Admin</b>\n\n` +
          `👥 <b>Usuarios activos:</b> ${activeUsers}\n` +
          `   ├ Google Drive: ${storageBreakdown.drive}\n` +
          `   ├ OneDrive: ${storageBreakdown.onedrive}\n` +
          `   └ Sin almacenamiento: ${storageBreakdown.none}\n\n` +
          `🔔 <b>Notificaciones enviadas:</b> ${totalNotifications.toLocaleString()}\n` +
          `📁 <b>Archivos subidos:</b> ${totalUploadedFiles.toLocaleString()}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.reply('❌ Error al obtener estadísticas.');
      logger.error({ err }, '/admin stats error');
    }
  });

  // ─── /status ────────────────────────────────────────────────────────────────
  // Salud operativa del último ciclo del orquestador (persistido por el core
  // en cycle_stats). Solo admin: expone métricas globales del sistema.

  /** Cadencia esperada del cron del core; pasado este margen, algo anda mal. */
  const CYCLE_STALE_AFTER_MS = 45 * 60_000;

  function formatAge(ms: number): string {
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return 'hace menos de 1 min';
    if (mins < 60) return `hace ${mins} min`;
    const hours = Math.floor(mins / 60);
    return `hace ${hours} h ${mins % 60} min`;
  }

  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!ADMIN_CHAT_ID || chatId !== ADMIN_CHAT_ID) return;

    try {
      const stats = await getLastCycleStats();
      if (!stats) {
        await ctx.reply('ℹ️ Aún no hay ciclos registrados (el core no ha corrido desde el deploy).');
        return;
      }

      const finishedAt = new Date(stats.finished_at);
      const ageMs = Date.now() - finishedAt.getTime();
      const durationSecs = Math.max(
        0,
        Math.round((finishedAt.getTime() - new Date(stats.started_at).getTime()) / 1000),
      );
      const timeCR = finishedAt.toLocaleTimeString('es-CR', {
        timeZone: 'America/Costa_Rica',
        hour: '2-digit',
        minute: '2-digit',
      });

      const usersOk = stats.users_processed;
      const notifsOk = stats.notifications_processed;
      const healthy =
        stats.users_failed === 0 &&
        stats.users_auth_failed === 0 &&
        stats.notifications_partial === 0;

      const lines = [
        `📡 <b>Status del sistema</b>`,
        ``,
        `🕐 <b>Último ciclo:</b> ${timeCR} (${formatAge(ageMs)}, duró ${durationSecs}s)`,
        `👥 <b>Usuarios:</b> ${usersOk}/${stats.users_total} OK` +
          (stats.users_auth_failed > 0
            ? ` — ${stats.users_auth_failed} con credenciales TEC vencidas`
            : '') +
          (stats.users_failed > 0 ? ` — ${stats.users_failed} con error de scrape` : ''),
        `🔔 <b>Notificaciones:</b> ${notifsOk} procesadas` +
          (stats.notifications_partial > 0
            ? `, ${stats.notifications_partial} fallidas (reintentan cada ciclo)`
            : stats.notifications_dispatched === 0
              ? ' (nada nuevo)'
              : ''),
      ];

      if (stats.dominant_error) {
        lines.push(`⚠️ <b>Error dominante:</b> <code>${escapeHtml(stats.dominant_error)}</code>`);
      }
      const errorCount = await countRecentErrors(24).catch(() => 0);
      if (errorCount > 0) {
        lines.push(`🧾 <b>Errores últimas 24 h:</b> ${errorCount} — detalle con /errores`);
      }
      if (ageMs > CYCLE_STALE_AFTER_MS) {
        lines.push(
          ``,
          `⏰ <b>Ojo:</b> el ciclo corre cada 30 min y el último fue ${formatAge(ageMs)} — el orquestador podría estar caído.`,
        );
      } else if (healthy) {
        lines.push(``, `✅ Todo en orden`);
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply('❌ Error al consultar el estado del sistema.');
      logger.error({ err }, '/status error');
    }
  });

  // ─── /errores ───────────────────────────────────────────────────────────────
  // Errores operativos de las últimas 24 h, agrupados y en cristiano — sin
  // tener que abrir docker logs. Solo admin.

  const ACTION_LABELS: Record<string, string> = {
    drive_upload: 'Subida a Drive',
    storage_folder: 'Carpeta de Drive/OneDrive',
    telegram_notice: 'Envío de noticia por Telegram',
    telegram_eval: 'Envío de evaluación por Telegram',
    telegram_doc_saved: 'Aviso de documento guardado',
    telegram_doc_fallback: 'Envío de links de documento',
    telegram_doc_download: 'Envío de links de documento',
    telegram_doc_link: 'Envío de link de documento',
    dispatch_internal: 'Procesamiento de notificación',
    studyos_forward: 'Envío a StudyOS',
    studyos_forward_permanent: 'Envío a StudyOS (descartado, error definitivo)',
    tec_auth_failed: 'Login TEC Digital',
    scrape_failed: 'Scrape de TEC Digital',
    drive_auth_alert: 'Aviso de renovación de Drive',
  };

  bot.command('errores', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!ADMIN_CHAT_ID || chatId !== ADMIN_CHAT_ID) return;

    try {
      const [total, groups] = await Promise.all([countRecentErrors(24), getErrorSummary(24)]);

      if (total === 0) {
        await ctx.reply('✅ Sin errores en las últimas 24 h.');
        return;
      }

      const lines = [`🧾 <b>Errores últimas 24 h:</b> ${total}`, ''];
      for (const g of groups) {
        const label = ACTION_LABELS[g.action] ?? g.action;
        const age = formatAge(Date.now() - new Date(g.last_at).getTime());
        lines.push(
          `⚠️ <b>${label}</b> — <code>${escapeHtml(g.error_message.slice(0, 120))}</code>`,
          `   ×${g.count} · último ${age}`,
          ``,
        );
      }
      lines.push(`<i>Se conservan 14 días. Agrupados por tipo de error.</i>`);

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply('❌ Error al consultar el registro de errores.');
      logger.error({ err }, '/errores error');
    }
  });

  // ─── Error handler ──────────────────────────────────────────────────────────

  bot.catch((err) => {
    const ctx = err.ctx;
    const update = { ...ctx.update } as any;

    // Prevent logging passwords in plaintext
    if (update.message?.text) {
      update.message.text = '[REDACTED_FOR_SECURITY]';
    }

    logger.error({ err: err.error, update }, 'Bot error');
  });

  // ─── Register commands & start polling ─────────────────────────────────────

  logger.info('Registering bot commands with Telegram');
  await bot.api.setMyCommands([
    { command: 'start', description: 'Registrar tu cuenta en el bot' },
    { command: 'actualizar', description: 'Actualizar correo, contraseña o carpeta de Drive' },
    { command: 'almacenamiento', description: 'Elegir Drive, OneDrive o ninguno' },
    { command: 'studyos', description: 'Conectar o ver el estado de tu StudyOS' },
    { command: 'estado', description: 'Ver el estado de tu registro' },
    { command: 'filtros', description: 'Silenciar cursos o comunidades' },
    { command: 'cancelar', description: 'Cancelar el registro en progreso' },
    { command: 'admin', description: 'Panel de administración' },
    { command: 'status', description: 'Salud del último ciclo de scraping (admin)' },
    { command: 'errores', description: 'Errores de las últimas 24 h (admin)' },
  ]);

  logger.info('Starting bot (long polling)');
  // drop_pending_updates: kills any lingering getUpdates session before we start ours.
  // This is safe — we only call this once per fresh bot instance.
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => logger.info({ username: info.username }, 'Bot is running'),
  });
}

async function mainWithRetry() {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 15_000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await main();
      return;
    } catch (err: unknown) {
      const is409 =
        err instanceof Error && (err.message.includes('409') || err.message.includes('Conflict'));
      if (is409 && attempt < MAX_RETRIES) {
        logger.warn(
          { attempt, nextAttemptInMs: RETRY_DELAY_MS },
          'Bot conflict (409) — retrying after delay...',
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        // Loop back — a new bot instance is created at the top of main()
      } else {
        logger.fatal({ err }, 'Fatal bot startup error');
        process.exit(1);
      }
    }
  }
  logger.fatal('Exceeded max retries for bot startup');
  process.exit(1);
}

mainWithRetry();
