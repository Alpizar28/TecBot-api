import crypto from 'crypto';
import {
    getNotificationState,
    insertNotification,
    updateNotificationDocumentStatus,
    uploadedFileExists,
    insertUploadedFile,
} from '@tec-brain/database';
import { TelegramService } from '@tec-brain/telegram';
import { DriveService } from '@tec-brain/drive';
import type { User, RawNotification, ScrapeResponse } from '@tec-brain/types';
import { logger } from './logger.js';

interface LoggerLike {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
}

export interface DispatchResult {
    processed: boolean;
    reason: string;
}

export async function dispatch(
    user: User,
    notification: RawNotification,
    cookies: ScrapeResponse['cookies'],
    telegram: TelegramService,
    drive: DriveService | null,
): Promise<DispatchResult> {
    const log = logger.child({
        component: 'dispatcher',
        userId: user.id,
        externalId: notification.external_id,
        type: notification.type,
    });

    const { exists, document_status: previousStatus } = await getNotificationState(user.id, notification.external_id);
    const isDocument = notification.type === 'documento';
    const resolvedNow = notification.document_status === 'resolved' && !!notification.files?.length;
    let hasPendingUploads = false;

    if (exists && isDocument && notification.files && notification.files.length > 0) {
        for (const file of notification.files) {
            const fileHash = crypto.createHash('sha256').update(file.download_url + file.file_name).digest('hex');
            if (!(await uploadedFileExists(user.id, fileHash))) {
                hasPendingUploads = true;
                break;
            }
        }
    }

    const shouldRetryDocument =
        exists &&
        isDocument &&
        resolvedNow &&
        (previousStatus !== 'resolved' || hasPendingUploads);

    if (exists && !shouldRetryDocument) {
        log.info({ previousStatus }, 'Duplicate notification already handled');
        return { processed: true, reason: 'duplicate' };
    }

    if (shouldRetryDocument) {
        log.info({ previousStatus, hasPendingUploads }, 'Retrying previously unresolved/partial document notification');
    }

    let processed = true;

    try {
        switch (notification.type) {
            case 'noticia': {
                processed = await safeTelegram(
                    user,
                    notification,
                    () => telegram.sendNotice(user, notification),
                    'telegram_notice',
                );
                break;
            }

            case 'evaluacion': {
                processed = await safeTelegram(
                    user,
                    notification,
                    () => telegram.sendEvaluation(user, notification),
                    'telegram_eval',
                );
                break;
            }

            case 'documento': {
                processed = await handleDocumentNotification(user, notification, cookies, telegram, drive, log);
                break;
            }
        }
    } catch (error) {
        processed = false;
        logStructuredError(user, notification, 'dispatch_internal', error);
    }

    if (processed || exists) {
        if (!exists) {
            log.info('Marking new notification as seen');
            await insertNotification(user.id, notification);
        } else if (shouldRetryDocument && notification.document_status === 'resolved') {
            log.info('Updating existing document notification status to resolved');
            await updateNotificationDocumentStatus(user.id, notification.external_id, 'resolved');
        }
    } else {
        log.warn('Notification had partial/failed processing and was not previously seen; skipping persistence to allow retry');
    }

    return {
        processed,
        reason: processed ? 'processed' : 'partial_or_failed',
    };
}

async function handleDocumentNotification(
    user: User,
    notification: RawNotification,
    cookies: ScrapeResponse['cookies'],
    telegram: TelegramService,
    drive: DriveService | null,
    log: LoggerLike,
): Promise<boolean> {
    if (drive && user.drive_root_folder_id && notification.files && notification.files.length > 0) {
        const userFolderId = await drive.ensureFolder(user.name, user.drive_root_folder_id);
        const courseFolderId = await drive.ensureFolder(notification.course, userFolderId);

        const results = await Promise.all(
            notification.files.map(async (file) => {
                try {
                    const fileHash = crypto.createHash('sha256').update(file.download_url + file.file_name).digest('hex');

                    if (await uploadedFileExists(user.id, fileHash)) {
                        log.info({ fileName: file.file_name }, 'Skipping duplicate document upload');
                        return true;
                    }

                    const { fileId } = await drive.downloadAndUpload(
                        file.download_url,
                        file.file_name,
                        courseFolderId,
                        cookies,
                    );

                    await insertUploadedFile(user.id, notification.course, fileHash, file.file_name, fileId);
                    const notified = await safeTelegram(
                        user,
                        notification,
                        () => telegram.sendDocumentSaved(user, notification, file.file_name, fileId),
                        'telegram_doc_saved',
                    );
                    return notified;
                } catch (error) {
                    logStructuredError(user, notification, 'drive_upload', error);
                    return await safeTelegram(
                        user,
                        notification,
                        () => telegram.sendDocumentDownload(user, notification, file.file_name, file.download_url),
                        'telegram_doc_fallback',
                    );
                }
            }),
        );

        return results.every(Boolean);
    }

    if (notification.files && notification.files.length > 0) {
        const results = await Promise.all(
            notification.files.map((file) => safeTelegram(
                user,
                notification,
                () => telegram.sendDocumentDownload(user, notification, file.file_name, file.download_url),
                'telegram_doc_download',
            )),
        );
        return results.every(Boolean);
    }

    return safeTelegram(
        user,
        notification,
        () => telegram.sendDocumentLink(user, notification),
        'telegram_doc_link',
    );
}

function logStructuredError(user: User, notif: RawNotification, action: string, err: unknown): void {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({
        component: 'dispatcher',
        userId: user.id,
        externalId: notif.external_id,
        type: notif.type,
        action,
        errorMessage: errorMsg,
    }, 'Dispatch action failed');
}

async function safeTelegram(
    user: User,
    notif: RawNotification,
    fn: () => Promise<void>,
    action: string,
): Promise<boolean> {
    try {
        await fn();
        return true;
    } catch (error) {
        logStructuredError(user, notif, action, error);
        return false;
    }
}
