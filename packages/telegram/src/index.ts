import axios, { type AxiosInstance } from 'axios';
import type { User, RawNotification } from '@tec-brain/types';

// ─── Message Formatters ───────────────────────────────────────────────────────

function formatNotice(user: User, n: RawNotification): string {
    return [
        `<b>${escapeHtml(n.course)}</b>`,
        escapeHtml(n.description),
        `<a href="${n.link}">TEC Digital</a>`,
    ].join('\n');
}

function formatEvaluation(user: User, n: RawNotification): string {
    return [
        `<b>${escapeHtml(n.course)}</b>`,
        escapeHtml(n.description),
        `<a href="${n.link}">Evaluación</a>`,
    ].join('\n');
}

function formatDocumentSent(user: User, n: RawNotification, fileName: string, driveFileId: string): string {
    const driveUrl = `https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/view`;
    return [
        `<b>${escapeHtml(n.course)}</b>`,
        escapeHtml(fileName),
        `<a href="${driveUrl}">Abrir en Drive</a>`,
    ].join('\n');
}

function formatDocumentDownload(user: User, n: RawNotification, fileName: string, url: string): string {
    return [
        `<b>${escapeHtml(n.course)}</b>`,
        escapeHtml(fileName),
        `<a href="${escapeHtml(url)}">Abrir en Drive</a>`,
    ].join('\n');
}

function formatDocumentLink(user: User, n: RawNotification): string {
    return [
        `<b>${escapeHtml(n.course)}</b>`,
        escapeHtml(n.description),
        `<a href="${n.link}">Documentos del curso</a>`,
    ].join('\n');
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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

    async sendDocumentSaved(user: User, n: RawNotification, fileName: string, driveFileId: string): Promise<void> {
        await this.sendMessage(user.telegram_chat_id, formatDocumentSent(user, n, fileName, driveFileId));
    }

    async sendDocumentDownload(user: User, n: RawNotification, fileName: string, url: string): Promise<void> {
        await this.sendMessage(user.telegram_chat_id, formatDocumentDownload(user, n, fileName, url));
    }

    async sendDocumentLink(user: User, n: RawNotification): Promise<void> {
        await this.sendMessage(user.telegram_chat_id, formatDocumentLink(user, n));
    }
}
