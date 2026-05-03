import axios, { type AxiosInstance } from 'axios';
import type { User, RawNotification, FileReference } from '@tec-brain/types';

const SEPARATOR = '───────────────';

// ─── Message Formatters ───────────────────────────────────────────────────────

function formatNotice(_user: User, n: RawNotification): string {
  const parts: string[] = [`📰 <b>${escapeHtml(n.course)}</b>`, SEPARATOR];

  // If we have a resolved title that differs from the description, show it
  const isGenericDescription = n.description.toLowerCase().includes('hay una nueva noticia');
  if (!isGenericDescription) {
    parts.push(`📌 <b>${escapeHtml(n.title)}</b>`);
    const body = n.description.length > 600 ? n.description.slice(0, 600) + '…' : n.description;
    parts.push(escapeHtml(body));
  } else {
    parts.push(escapeHtml(n.description));
  }

  const targetUrl = n.resolved_link ?? n.link;
  parts.push(`🔗 <a href="${targetUrl}">Ver en TEC Digital</a>`);
  return parts.join('\n');
}

function formatEvaluation(_user: User, n: RawNotification): string {
  return [
    `📝 <b>${escapeHtml(n.course)}</b>`,
    SEPARATOR,
    `📌 ${escapeHtml(n.description)}`,
    ``,
    `🔗 <a href="${n.link}">Ver evaluación en TEC Digital</a>`,
  ].join('\n');
}

function formatDocumentLink(_user: User, n: RawNotification): string {
  return [
    `📁 <b>${escapeHtml(n.course)}</b>`,
    SEPARATOR,
    `📌 ${escapeHtml(n.description)}`,
    ``,
    `🔗 <a href="${n.link}">Ver documentos del curso</a>`,
  ].join('\n');
}

interface StorageFileInfo {
  fileName: string;
  fileId: string;
  fileUrl?: string;
}

function formatDocumentsSaved(
  _user: User,
  n: RawNotification,
  files: StorageFileInfo[],
): string {
  const parts: string[] = [
    `📁 <b>${escapeHtml(n.course)}</b>`,
    SEPARATOR,
    `📌 ${escapeHtml(n.description)}`,
    ``,
    `Se agregaron ${files.length} archivo${files.length > 1 ? 's' : ''}:`,
    ``,
  ];

  for (const file of files) {
    const url = file.fileUrl ?? `https://drive.google.com/file/d/${encodeURIComponent(file.fileId)}/view`;
    parts.push(`📄 ${escapeHtml(file.fileName)}`);
    parts.push(`└── 📎 <a href="${url}">Abrir archivo</a>`);
    parts.push('');
  }

  parts.push(`🔗 <a href="${n.link}">Ver todos los documentos del curso</a>`);
  return parts.join('\n');
}

function formatDocumentsDownload(
  _user: User,
  n: RawNotification,
  files: FileReference[],
): string {
  const parts: string[] = [
    `📁 <b>${escapeHtml(n.course)}</b>`,
    SEPARATOR,
    `📌 ${escapeHtml(n.description)}`,
    ``,
    `Se agregaron ${files.length} archivo${files.length > 1 ? 's' : ''}:`,
    ``,
  ];

  for (const file of files) {
    parts.push(`📄 ${escapeHtml(file.file_name)}`);
    parts.push(`└── 🔗 <a href="${escapeHtml(file.download_url)}">Descargar</a>`);
    parts.push('');
  }

  parts.push(`🔗 <a href="${n.link}">Ver todos los documentos del curso</a>`);
  return parts.join('\n');
}

function formatDriveAuthExpired(_user: User): string {
  return [
    '<b>⚠️ Atención: autoriza Drive de nuevo</b>',
    '',
    'Tu sesión de Google Drive expiró y no podemos guardar documentos.',
    '',
    'Usa <b>/actualizar</b> para volver a enlazar tu cuenta.',
  ].join('\n');
}

function formatOneDriveAuthExpired(_user: User): string {
  return [
    '<b>⚠️ Atención: autoriza OneDrive de nuevo</b>',
    '',
    'Tu sesión de OneDrive expiró y no podemos guardar documentos.',
    '',
    'Usa <b>/almacenamiento</b> para volver a enlazar tu cuenta.',
  ].join('\n');
}

function formatTecAuthExpired(_user: User): string {
  return [
    '<b>⚠️ No pudimos acceder a tu cuenta del TEC Digital</b>',
    '',
    'Parece que tu contraseña cambió o ya no es válida.',
    '',
    'Por favor, actualiza tus credenciales usando el comando <b>/actualizar</b> para seguir recibiendo notificaciones.',
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class TelegramService {
  private readonly http: AxiosInstance;

  constructor(token: string) {
    if (!token) throw new Error('[TelegramService] Token is required');
    this.http = axios.create({
      baseURL: `https://api.telegram.org/bot${token}`,
      timeout: 15_000,
    });
  }

  /**
   * Sends an HTML-formatted text message.
   */
  async sendMessage(chatId: string, html: string): Promise<void> {
    await this.http.post('/sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
  }

  async sendNotice(user: User, n: RawNotification): Promise<void> {
    await this.sendMessage(user.telegram_chat_id, formatNotice(user, n));
  }

  async sendEvaluation(user: User, n: RawNotification): Promise<void> {
    await this.sendMessage(user.telegram_chat_id, formatEvaluation(user, n));
  }

  async sendDocumentLink(user: User, n: RawNotification): Promise<void> {
    await this.sendMessage(user.telegram_chat_id, formatDocumentLink(user, n));
  }

  async sendDocumentsSaved(
    user: User,
    n: RawNotification,
    files: StorageFileInfo[],
  ): Promise<void> {
    await this.sendMessage(
      user.telegram_chat_id,
      formatDocumentsSaved(user, n, files),
    );
  }

  async sendDocumentsDownload(
    user: User,
    n: RawNotification,
    files: FileReference[],
  ): Promise<void> {
    await this.sendMessage(
      user.telegram_chat_id,
      formatDocumentsDownload(user, n, files),
    );
  }

  // Legacy per-file methods (kept for backward compatibility)
  async sendDocumentSaved(
    user: User,
    n: RawNotification,
    fileName: string,
    driveFileId: string,
    fileUrl?: string,
  ): Promise<void> {
    const url = fileUrl ?? `https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/view`;
    await this.sendMessage(
      user.telegram_chat_id,
      [
        `📁 <b>${escapeHtml(n.course)}</b>`,
        SEPARATOR,
        `📄 ${escapeHtml(fileName)}`,
        `└── 📎 <a href="${url}">Abrir archivo</a>`,
      ].join('\n'),
    );
  }

  async sendDocumentDownload(
    user: User,
    n: RawNotification,
    fileName: string,
    url: string,
  ): Promise<void> {
    await this.sendMessage(
      user.telegram_chat_id,
      [
        `📁 <b>${escapeHtml(n.course)}</b>`,
        SEPARATOR,
        `📄 ${escapeHtml(fileName)}`,
        `└── 🔗 <a href="${escapeHtml(url)}">Descargar</a>`,
      ].join('\n'),
    );
  }

  async sendDriveAuthExpired(user: User): Promise<void> {
    await this.sendMessage(user.telegram_chat_id, formatDriveAuthExpired(user));
  }

  async sendOneDriveAuthExpired(user: User): Promise<void> {
    await this.sendMessage(user.telegram_chat_id, formatOneDriveAuthExpired(user));
  }

  async sendTecAuthExpired(user: User): Promise<void> {
    await this.sendMessage(user.telegram_chat_id, formatTecAuthExpired(user));
  }
}
