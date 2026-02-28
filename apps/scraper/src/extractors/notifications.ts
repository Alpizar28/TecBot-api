import axios from 'axios';
import type { RawNotification } from '@tec-brain/types';
import { TecHttpClient } from '../clients/tec-http.client.js';
import { logger } from '../logger.js';

interface TecNotificationItem {
    id?: string;
    text?: string;
    type_hint?: string;
    url?: string;
    date_text?: string;
}

interface InternalDispatchResponse {
    status: 'success' | 'error';
    processed?: boolean;
    error?: string;
}

const extractorLogger = logger.child({ component: 'notifications_extractor' });
const HTTP_RETRY_ATTEMPTS = parseInt(process.env.HTTP_RETRY_ATTEMPTS ?? '3', 10);
const HTTP_RETRY_BASE_MS = parseInt(process.env.HTTP_RETRY_BASE_MS ?? '400', 10);

interface EndpointMetric {
    calls: number;
    ok: number;
    failed: number;
    retries: number;
    totalMs: number;
}

type MetricStore = Record<string, EndpointMetric>;

export async function extractNotifications(client: TecHttpClient): Promise<RawNotification[]> {
    const notifications: RawNotification[] = [];
    const metrics: MetricStore = {};

    try {
        extractorLogger.debug('Fetching unread notifications via API');
        await requestWithRetry(
            () => client.client.get('https://tecdigital.tec.ac.cr/tda-notifications/ajax/has_unread_notifications?'),
            {
                endpoint: 'tec.has_unread_notifications',
                metrics,
                logger: extractorLogger,
            },
        );
        const notifRes = await requestWithRetry(
            () => client.client.get('https://tecdigital.tec.ac.cr/tda-notifications/ajax/get_user_notifications?'),
            {
                endpoint: 'tec.get_user_notifications',
                metrics,
                logger: extractorLogger,
            },
        );

        if (notifRes.status !== 200 || !Array.isArray(notifRes.data?.notifications)) {
            extractorLogger.warn({ status: notifRes.status }, 'Notification API response is not valid');
            return notifications;
        }

        for (const item of notifRes.data.notifications as TecNotificationItem[]) {
            const parsed = await normalizeNotification(client, item);
            notifications.push(parsed);
        }
    } catch (error) {
        extractorLogger.error({ error }, 'Failed to fetch notifications');
    } finally {
        logMetrics('extractNotifications', metrics);
    }

    return notifications;
}

export async function processNotificationsSequentially(
    client: TecHttpClient,
    userId: string,
    dispatchUrl: string,
    cookies: { name: string; value: string; domain?: string; path?: string }[],
    keywords: string[] = [],
): Promise<void> {
    const metrics: MetricStore = {};
    try {
        extractorLogger.info({ userId }, 'Starting sequential notification processing');
        await requestWithRetry(
            () => client.client.get('https://tecdigital.tec.ac.cr/tda-notifications/ajax/has_unread_notifications?'),
            {
                endpoint: 'tec.has_unread_notifications',
                metrics,
                logger: extractorLogger,
            },
        );
        const notifRes = await requestWithRetry(
            () => client.client.get('https://tecdigital.tec.ac.cr/tda-notifications/ajax/get_user_notifications?'),
            {
                endpoint: 'tec.get_user_notifications',
                metrics,
                logger: extractorLogger,
            },
        );

        if (notifRes.status !== 200 || !Array.isArray(notifRes.data?.notifications)) {
            extractorLogger.warn({ userId, status: notifRes.status }, 'Could not retrieve notifications via API');
            return;
        }

        const items = notifRes.data.notifications as TecNotificationItem[];
        extractorLogger.info({ userId, total: items.length }, 'Notifications fetched for sequential processing');

        for (const [index, item] of items.entries()) {
            try {
                const parsed = await normalizeNotification(client, item);

                if (!parsed.link) {
                    extractorLogger.debug({ userId, index }, 'Skipping notification without link');
                    continue;
                }

                if (
                    keywords.length > 0 &&
                    !keywords.some((kw) => parsed.course.toLowerCase().includes(kw.toLowerCase()))
                ) {
                    extractorLogger.debug({ userId, index, course: parsed.course }, 'Notification filtered by keywords');
                    continue;
                }

                const response = await requestWithRetry(
                    () => axios.post<InternalDispatchResponse>(
                        dispatchUrl,
                        {
                            userId,
                            notification: parsed,
                            cookies,
                        },
                        { timeout: 120_000 },
                    ),
                    {
                        endpoint: 'core.internal_dispatch',
                        metrics,
                        logger: extractorLogger,
                    },
                );

                const shouldDelete = shouldDeleteFromTec(response.status, response.data);

                if (!shouldDelete) {
                    extractorLogger.warn({
                        userId,
                        externalId: parsed.external_id,
                        status: response.status,
                        dispatchResponse: response.data,
                    }, 'Skipping TEC delete because Core did not fully process notification');
                    continue;
                }

                if (!item.id) {
                    extractorLogger.warn({ userId, externalId: parsed.external_id }, 'Missing TEC notification id');
                    continue;
                }

                const delUrl =
                    `https://tecdigital.tec.ac.cr/tda-notifications/ajax/notification_delete?notification_id=${item.id}`;
                const delRes = await requestWithRetry(
                    () => client.client.get(delUrl),
                    {
                        endpoint: 'tec.notification_delete',
                        metrics,
                        logger: extractorLogger,
                    },
                );

                if (delRes.status === 200) {
                    extractorLogger.info({ userId, notificationId: item.id, externalId: parsed.external_id }, 'Notification deleted in TEC');
                } else {
                    extractorLogger.warn({
                        userId,
                        notificationId: item.id,
                        status: delRes.status,
                    }, 'TEC delete endpoint returned non-200');
                }
            } catch (error) {
                extractorLogger.error({ userId, index, error }, 'Error processing notification sequentially');
            }
        }
    } catch (error) {
        extractorLogger.error({ userId, error }, 'Sequential processor failed');
    } finally {
        logMetrics('processNotificationsSequentially', metrics, { userId });
    }
}

async function normalizeNotification(client: TecHttpClient, item: TecNotificationItem): Promise<RawNotification> {
    const text = (item.text ?? '').trim();
    const link = item.url ?? '';
    const type = classifyType(item.type_hint ?? '', text, link);
    const course = extractCourse(text);

    let files: NonNullable<RawNotification['files']> | undefined;
    let document_status: RawNotification['document_status'] | undefined;

    if (type === 'documento' && link) {
        const resolved = await resolveDocumentFiles(client, link);
        files = resolved;
        document_status = resolved.length > 0 ? 'resolved' : 'unresolved';
    }

    return {
        external_id: `notif_${hashString(`${link}|${text.slice(0, 120)}`)}`,
        type,
        course,
        title: text.split(' - ')[0] || text.slice(0, 120) || 'Notificación TEC',
        description: text || 'Sin descripción',
        link,
        date: item.date_text || new Date().toISOString().slice(0, 10),
        files,
        document_status,
    };
}

async function resolveDocumentFiles(
    client: TecHttpClient,
    docLink: string,
): Promise<NonNullable<RawNotification['files']>> {
    try {
        const completeUrl = ensureAbsoluteUrl(docLink);
        const files: NonNullable<RawNotification['files']> = [];
        const dedupe = new Set<string>();
        const folderId = extractFolderId(completeUrl);

        if (folderId) {
            extractorLogger.debug({ folderId }, 'Detected folder id, calling folder API');
            const folderApiUrl = `https://tecdigital.tec.ac.cr/dotlrn/file-storage/api/folder/${folderId}`;
            const folderRes = await client.client.get(folderApiUrl, {
                headers: { Accept: 'application/json, text/plain, */*' },
            });

            if (folderRes.status === 200) {
                // The new endpoint returns an object with an "elements" array.
                // normalizeFolderResponse expects an array, so if it's an object with "elements", pass that.
                const elements = folderRes.data && Array.isArray(folderRes.data.elements)
                    ? folderRes.data.elements
                    : normalizeFolderResponse(folderRes.data);

                for (const fileItem of elements) {
                    const kind = String(fileItem.type ?? fileItem.fs_type ?? '').toLowerCase();
                    const fileId = fileItem.file_id;
                    const objectId = fileItem.object_id;
                    // Usually we only want files, not subfolders. But subfolders might be typed as 'folder' in fs_type.
                    if (kind && kind !== 'file' && kind !== 'application/pdf' && !kind.includes('application/')) continue;
                    if (!fileId && !objectId) continue;

                    const extractedTitle = fileItem.title ?? fileItem.name ?? fileItem.file_upload_name;
                    const title = sanitizeFileName(String(extractedTitle ?? `Documento-${fileId ?? objectId}`));

                    const downloadUrl =
                        typeof fileItem.download_url === 'string' && fileItem.download_url
                            ? ensureAbsoluteUrl(fileItem.download_url)
                            : buildDownloadUrl(fileId, objectId, title);
                    const mimeType = inferMimeType(title, downloadUrl, fileItem.mime_type);

                    pushUniqueFile(files, dedupe, {
                        file_name: title,
                        download_url: downloadUrl,
                        source_url: docLink,
                        mime_type: mimeType,
                    });
                }
            }
        } else {
            extractorLogger.debug({ url: completeUrl }, 'Falling back to HTML parsing for document files');
            const res = await client.client.get<string>(completeUrl);
            const html = String(res.data ?? '');

            const htmlFolderId = extractFolderIdFromHtml(html);
            if (htmlFolderId) {
                const folderApiUrl = `https://tecdigital.tec.ac.cr/dotlrn/file-storage/api/folder/${htmlFolderId}`;
                const folderRes = await client.client.get(folderApiUrl, {
                    headers: { Accept: 'application/json, text/plain, */*' },
                });

                if (folderRes.status === 200) {
                    const elements = folderRes.data && Array.isArray(folderRes.data.elements)
                        ? folderRes.data.elements
                        : normalizeFolderResponse(folderRes.data);

                    for (const fileItem of elements) {
                        const kind = String(fileItem.type ?? fileItem.fs_type ?? '').toLowerCase();
                        const fileId = fileItem.file_id;
                        const objectId = fileItem.object_id;
                        if (kind && kind !== 'file' && kind !== 'application/pdf' && !kind.includes('application/')) continue;
                        if (!fileId && !objectId) continue;

                        const extractedTitle = fileItem.title ?? fileItem.name ?? fileItem.file_upload_name;
                        const title = sanitizeFileName(String(extractedTitle ?? `Documento-${fileId ?? objectId}`));

                        const downloadUrl =
                            typeof fileItem.download_url === 'string' && fileItem.download_url
                                ? ensureAbsoluteUrl(fileItem.download_url)
                                : buildDownloadUrl(fileId, objectId, title);
                        const mimeType = inferMimeType(title, downloadUrl, fileItem.mime_type);

                        pushUniqueFile(files, dedupe, {
                            file_name: title,
                            download_url: downloadUrl,
                            source_url: docLink,
                            mime_type: mimeType,
                        });
                    }
                }
            }

        }

        extractorLogger.info({ source: docLink, count: files.length }, 'Resolved document files');
        return files;
    } catch (error) {
        extractorLogger.error({ source: docLink, error }, 'Error resolving document files');
        return [];
    }
}

interface RetryContext {
    endpoint: string;
    metrics: MetricStore;
    logger: typeof extractorLogger;
}

async function requestWithRetry<T>(
    request: () => Promise<T>,
    context: RetryContext,
): Promise<T> {
    const maxAttempts = Math.max(1, HTTP_RETRY_ATTEMPTS);
    const metric = getMetric(context.metrics, context.endpoint);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = Date.now();
        try {
            const result = await request();
            metric.calls += 1;
            metric.ok += 1;
            metric.totalMs += Date.now() - startedAt;
            if (attempt > 1) metric.retries += attempt - 1;
            return result;
        } catch (error) {
            metric.calls += 1;
            metric.failed += 1;
            metric.totalMs += Date.now() - startedAt;

            const retryable = isRetryableHttpError(error);
            if (!retryable || attempt === maxAttempts) {
                throw error;
            }

            const sleepMs = backoffWithJitter(attempt, HTTP_RETRY_BASE_MS);
            context.logger.warn({
                endpoint: context.endpoint,
                attempt,
                maxAttempts,
                sleepMs,
            }, 'Retrying request after retryable error');
            await sleep(sleepMs);
        }
    }

    throw new Error(`Retry loop exhausted for ${context.endpoint}`);
}

function isRetryableHttpError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return true;
    const status = error.response?.status;
    if (!status) return true;
    return status >= 500 || status === 408 || status === 429;
}

function backoffWithJitter(attempt: number, baseMs: number): number {
    const cappedAttempt = Math.min(attempt, 6);
    const exp = baseMs * (2 ** (cappedAttempt - 1));
    const jitter = Math.floor(Math.random() * baseMs);
    return exp + jitter;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMetric(metrics: MetricStore, endpoint: string): EndpointMetric {
    if (!metrics[endpoint]) {
        metrics[endpoint] = { calls: 0, ok: 0, failed: 0, retries: 0, totalMs: 0 };
    }
    return metrics[endpoint];
}

function logMetrics(flow: string, metrics: MetricStore, extra?: Record<string, unknown>): void {
    const serialized = Object.entries(metrics).map(([endpoint, metric]) => ({
        endpoint,
        ...metric,
        avgMs: metric.calls > 0 ? Math.round(metric.totalMs / metric.calls) : 0,
    }));
    extractorLogger.info({
        flow,
        ...extra,
        endpointMetrics: serialized,
    }, 'HTTP endpoint metrics');
}

export function shouldDeleteFromTec(
    httpStatus: number,
    dispatchBody: InternalDispatchResponse | undefined,
): boolean {
    return (
        httpStatus === 200 &&
        dispatchBody?.status === 'success' &&
        dispatchBody?.processed === true
    );
}

export function classifyType(typeHint: string, text: string, link: string): RawNotification['type'] {
    const source = `${typeHint} ${text} ${link}`.toLowerCase();
    const documentSignals = [
        'documento',
        'archivo',
        'adjunto',
        'material',
        'file-storage',
        '.pdf',
        '.doc',
        '.ppt',
        '.xls',
    ];
    if (documentSignals.some((signal) => source.includes(signal))) {
        return 'documento';
    }

    const evaluationSignals = [
        'evaluaci',
        'tarea',
        'examen',
        'quiz',
        'laboratorio',
        'proyecto',
        'parcial',
    ];
    if (evaluationSignals.some((signal) => source.includes(signal))) {
        return 'evaluacion';
    }

    return 'noticia';
}

export function extractCourse(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return 'Curso Desconocido';

    const labeled = normalized.match(/(?:curso|course)\s*:\s*([^|]{4,80})/i);
    if (labeled?.[1]) return cleanCourseCandidate(labeled[1]);

    const separators = [' - ', ' – ', ': ', ' | '];
    for (const separator of separators) {
        const idx = normalized.indexOf(separator);
        if (idx > 0) {
            const candidate = cleanCourseCandidate(normalized.slice(0, idx));
            if (candidate.length >= 4) return candidate;
        }
    }

    const courseCode = normalized.match(/\b([A-Z]{2,4}\d{3,4})\b/);
    if (courseCode?.[1]) return courseCode[1];

    return cleanCourseCandidate(normalized.slice(0, 80));
}

function cleanCourseCandidate(value: string): string {
    return value
        .replace(/^[-:| ]+/, '')
        .replace(/[-:| ]+$/, '')
        .trim()
        .slice(0, 80) || 'Curso Desconocido';
}

export function ensureAbsoluteUrl(url: string): string {
    const trimmed = url.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return `https://tecdigital.tec.ac.cr${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

function extractFolderId(url: string): string | null {
    const patterns = [
        /#\/(\d+)#\//,
        /folder_id=(\d+)/,
        /#\/folder\/(\d+)/,
        /folderId=(\d+)/,
        /folder_id%3D(\d+)/i,
        /folderId%3D(\d+)/i,
        /#\/folders\/(\d+)/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match?.[1]) return match[1];
    }
    return null;
}

function buildDownloadUrl(fileId: unknown, objectId: unknown, fileName: string): string {
    if (typeof fileId === 'number' || typeof fileId === 'string') {
        return `https://tecdigital.tec.ac.cr/dotlrn/file-storage/download/${encodeURIComponent(fileName)}?file_id=${String(fileId)}`;
    }
    if (typeof objectId === 'number' || typeof objectId === 'string') {
        return `https://tecdigital.tec.ac.cr/dotlrn/file-storage/download/${encodeURIComponent(fileName)}?object_id=${String(objectId)}`;
    }
    return `https://tecdigital.tec.ac.cr/dotlrn/file-storage/download/${encodeURIComponent(fileName)}`;
}

function pushUniqueFile(
    files: NonNullable<RawNotification['files']>,
    dedupe: Set<string>,
    file: NonNullable<RawNotification['files']>[number],
): void {
    const key = `${file.download_url}|${file.file_name}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    files.push(file);
}

function sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'documento';
}

function guessFileNameFromUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        const candidate = decodeURIComponent(pathParts[pathParts.length - 1] ?? '');
        return candidate || null;
    } catch {
        return null;
    }
}

function extractFolderIdFromHtml(html: string): string | null {
    const patterns = [
        /folder_id\s*[:=]\s*["']?(\d+)["']?/i,
        /folderId\s*[:=]\s*["']?(\d+)["']?/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return match[1];
    }
    return null;
}

function normalizeFolderResponse(data: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
    if (!data || typeof data !== 'object') return [];

    const obj = data as Record<string, unknown>;
    const candidateKeys = ['files', 'items', 'entries', 'data', 'children', 'results'];
    for (const key of candidateKeys) {
        const value = obj[key];
        if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    }

    for (const value of Object.values(obj)) {
        if (!Array.isArray(value)) continue;
        if (value.some(isFileItemLike)) return value as Array<Record<string, unknown>>;
    }

    return [];
}

function isFileItemLike(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return (
        'file_id' in item ||
        'object_id' in item ||
        'download_url' in item ||
        'name' in item ||
        'title' in item
    );
}

function unescapeJsonUrl(value: string): string {
    return value
        .replace(/\\u002F/gi, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/')
        .replace(/\\&/g, '&');
}

function inferMimeType(fileName: string, downloadUrl: string, mimeTypeCandidate?: unknown): string | undefined {
    if (typeof mimeTypeCandidate === 'string' && mimeTypeCandidate.trim()) {
        return mimeTypeCandidate;
    }

    const source = `${fileName} ${downloadUrl}`.toLowerCase();
    if (source.includes('.pdf')) return 'application/pdf';
    if (source.includes('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (source.includes('.doc')) return 'application/msword';
    if (source.includes('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (source.includes('.ppt')) return 'application/vnd.ms-powerpoint';
    if (source.includes('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (source.includes('.xls')) return 'application/vnd.ms-excel';
    if (source.includes('.zip')) return 'application/zip';
    if (source.includes('.txt')) return 'text/plain';
    return undefined;
}

function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}
