import 'dotenv/config';
import { Bot, session, type SessionFlavor, type Context } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { pino } from 'pino';
import {
  runMigrations,
  encrypt,
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

const CORE_BASE_URL = process.env.CORE_BASE_URL ?? 'http://core:3002';

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
const lastCommandAt = new Map<string, number>();

function isRateLimited(chatId: string): boolean {
  const now = Date.now();
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

  bot.use(confirmMenu);
  bot.use(skipDriveMenu);
  bot.use(updateMenu);
  bot.use(storageMenu);

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
    { command: 'estado', description: 'Ver el estado de tu registro' },
    { command: 'filtros', description: 'Silenciar cursos o comunidades' },
    { command: 'cancelar', description: 'Cancelar el registro en progreso' },
    { command: 'admin', description: 'Panel de administración' },
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
