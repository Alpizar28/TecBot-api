import 'dotenv/config';
import { Bot, session, type SessionFlavor, type Context } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { pino } from 'pino';
import {
  getPool,
  runMigrations,
  encrypt,
  createUser,
  updateUser,
  getPendingRegistration,
  upsertPendingRegistration,
  advancePendingRegistration,
  deletePendingRegistration,
  getUserById,
  getUserByTelegramChatId,
  getUserByTecUsername,
  createOAuthState,
  type RegistrationStep,
} from '@tec-brain/database';
import { loadOAuthClientConfig, getAuthorizationUrl, type OAuthClient } from '@tec-brain/drive';

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

// ─── OAuth client (optional — Drive integration) ──────────────────────────────

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

// ─── Bot setup ────────────────────────────────────────────────────────────────

// We use a minimal session just to satisfy grammy's type system;
// real state lives in the DB (pending_registrations table).
interface SessionData {
  _: null;
}
type BotContext = Context & SessionFlavor<SessionData>;

const bot = new Bot<BotContext>(BOT_TOKEN);
bot.use(session({ initial: (): SessionData => ({ _: null }) }));

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

/** Builds the Google Drive auth URL for a user and returns it. */
async function buildDriveAuthUrl(userId: string): Promise<string> {
  if (!oauthClient) throw new Error('OAuth client not configured');
  const state = await createOAuthState(userId);
  return getAuthorizationUrl(oauthClient, state);
}

// ─── Menus ────────────────────────────────────────────────────────────────────

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
        });
      } else {
        // Brand new user
        userId = await createUser({
          name: displayName,
          tec_username: pending.tec_username,
          tec_password_enc: pending.tec_password_enc,
          telegram_chat_id: chatId,
          drive_root_folder_id: pending.drive_folder_id ?? null,
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

    // ── Drive OAuth ─────────────────────────────────────────────────────────────
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

bot.use(confirmMenu);
bot.use(skipDriveMenu);

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const chatId = String(ctx.chat.id);
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

// ─── /actualizar ──────────────────────────────────────────────────────────────

bot.command('actualizar', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const existingUser = await getUserByTelegramChatId(chatId);

  if (!existingUser) {
    await ctx.reply('❌ No tienes una cuenta registrada. Envía /start para comenzar.');
    return;
  }

  await upsertPendingRegistration(chatId);

  await ctx.reply(
    `🔄 <b>Modo de actualización</b>\n\n` +
      `Vamos a actualizar tus datos. Este proceso reemplazará tu configuración anterior (pero las notificaciones ya enviadas no se perderán).\n\n` +
      `─────────────────────\n` +
      `📧 <b>Paso 1 de 3</b>\n` +
      `¿Cuál es tu correo institucional del TEC?\n\n` +
      `<i>Ejemplo: tu.nombre@estudiantec.cr</i>`,
    { parse_mode: 'HTML' },
  );
  logger.info({ chatId }, '/actualizar — registration reset, awaiting_username');
});

// ─── /cancelar ────────────────────────────────────────────────────────────────

bot.command('cancelar', async (ctx) => {
  const chatId = String(ctx.chat.id);
  await deletePendingRegistration(chatId);
  await ctx.reply('❌ Registro cancelado. Envía /start cuando quieras intentarlo de nuevo.', {
    parse_mode: 'HTML',
  });
});

// ─── /estado ──────────────────────────────────────────────────────────────────

bot.command('estado', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const pending = await getPendingRegistration(chatId);

  if (!pending || pending.step === 'done') {
    await ctx.reply(
      '✅ Ya estás registrado y recibiendo notificaciones.\n\n' +
        'Si necesitas actualizar tus datos, envía /start para volver a configurarte.',
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
  };

  await ctx.reply(
    `🔄 Tienes un registro en progreso.\n\n` +
      `<b>Estado actual:</b> ${stepLabels[pending.step]}\n\n` +
      `Continúa respondiendo a las preguntas anteriores, o envía /cancelar para empezar de nuevo.`,
    { parse_mode: 'HTML' },
  );
});

// ─── Message handler — main conversation flow ─────────────────────────────────

bot.on('message:text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text.trim();

  // Ignore commands (already handled above)
  if (text.startsWith('/')) return;

  const pending = await getPendingRegistration(chatId);

  if (!pending || pending.step === 'done') {
    await ctx.reply('Envía /start para registrarte y comenzar a recibir notificaciones del TEC.');
    return;
  }

  // ── Step 1: TEC username ────────────────────────────────────────────────────
  if (pending.step === 'awaiting_username') {
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
        '⚠️ Ese correo ya está registrado y asociado a otra cuenta de Telegram.\n\n' +
          'Si eres el dueño y perdiste acceso a tu cuenta anterior, por favor contacta al administrador del sistema.',
      );
      return;
    }

    await advancePendingRegistration(chatId, 'awaiting_password', {
      tec_username: email,
    });

    await ctx.reply(
      `✅ Correo guardado: <code>${email}</code>\n\n` +
        `─────────────────────\n` +
        `🔑 <b>Paso 2 de 3</b>\n` +
        `¿Cuál es tu contraseña de TEC Digital?\n\n` +
        `<i>Tu contraseña se cifra con AES-256 antes de guardarse. Nadie puede leerla en texto plano.</i>\n\n` +
        `⚠️ <b>Después de que la envíes, borra el mensaje</b> por seguridad.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // ── Step 2: TEC password ────────────────────────────────────────────────────
  if (pending.step === 'awaiting_password') {
    if (text.length < 4) {
      await ctx.reply('⚠️ La contraseña parece muy corta. Inténtalo de nuevo.');
      return;
    }

    const encryptedPwd = encrypt(text);

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

  // ── Step 3: Drive folder ────────────────────────────────────────────────────
  if (pending.step === 'awaiting_drive_folder') {
    let folderId: string | null = null;

    if (text.toLowerCase() !== 'no') {
      folderId = parseDriveFolderId(text);
      if (!folderId) {
        await ctx.reply(
          '⚠️ No pude identificar un ID de carpeta de Google Drive en lo que enviaste.\n\n' +
            '• Copia el ID directamente de la URL de Drive:\n' +
            '  <code>drive.google.com/drive/folders/<b>1AbcXyz...</b></code>\n\n' +
            '• O presiona el botón para omitir Drive.',
          { parse_mode: 'HTML', reply_markup: skipDriveMenu },
        );
        return;
      }
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

  // ── Step 4: Confirmation (fallback if typed) ────────────────────────────────
  if (pending.step === 'awaiting_confirmation') {
    await ctx.reply('Por favor, usa los botones de arriba para confirmar o cancelar el registro.', {
      reply_markup: confirmMenu,
    });
    return;
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  const ctx = err.ctx;
  const update = { ...ctx.update } as any;

  // Prevent logging passwords in plaintext
  if (update.message?.text) {
    update.message.text = '[REDACTED_FOR_SECURITY]';
  }

  logger.error({ err: err.error, update }, 'Bot error');
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  logger.info('Running database migrations');
  await runMigrations();
  logger.info('Migrations complete');

  logger.info('Starting bot (long polling)');
  // Start long-polling — grammY handles reconnects automatically
  await bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'Bot is running'),
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal bot startup error');
  process.exit(1);
});
