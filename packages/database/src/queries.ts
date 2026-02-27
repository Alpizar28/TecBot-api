import crypto from 'crypto';
import type pg from 'pg';
import { getPool } from './client.js';
import type { User, StoredNotification, RawNotification } from '@tec-brain/types';

// ─── User Queries ─────────────────────────────────────────────────────────────

export async function getActiveUsers(): Promise<User[]> {
    const pool = getPool();
    const res = await pool.query<User>('SELECT * FROM users WHERE is_active = TRUE ORDER BY created_at');
    return res.rows;
}

export async function getUserById(id: string): Promise<User | null> {
    const pool = getPool();
    const res = await pool.query<User>('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] ?? null;
}

// ─── Notification Queries ─────────────────────────────────────────────────────

/**
 * Returns whether a notification has already been sent for a given user.
 */
export async function notificationExists(userId: string, externalId: string): Promise<boolean> {
    const pool = getPool();
    const res = await pool.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND external_id = $2',
        [userId, externalId],
    );
    return parseInt(res.rows[0].count, 10) > 0;
}

/**
 * Returns whether a notification exists, and its document_status (if present).
 */
export async function getNotificationState(
    userId: string,
    externalId: string,
): Promise<{ exists: boolean; document_status: RawNotification['document_status'] | null }> {
    const pool = getPool();
    const res = await pool.query<{ document_status: RawNotification['document_status'] | null }>(
        'SELECT document_status FROM notifications WHERE user_id = $1 AND external_id = $2 LIMIT 1',
        [userId, externalId],
    );

    if (res.rowCount === 0) {
        return { exists: false, document_status: null };
    }

    return { exists: true, document_status: res.rows[0].document_status ?? null };
}

/**
 * Inserts a notification record. Ignores conflicts (already sent).
 */
export async function insertNotification(
    userId: string,
    notification: RawNotification,
): Promise<void> {
    const pool = getPool();
    const hash = crypto
        .createHash('sha256')
        .update(`${notification.external_id}:${notification.description ?? ''}`)
        .digest('hex');

    await pool.query(
        `INSERT INTO notifications
       (user_id, external_id, type, course, title, description, link, hash, document_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, external_id) DO NOTHING`,
        [
            userId,
            notification.external_id,
            notification.type,
            notification.course,
            notification.title,
            notification.description,
            notification.link,
            hash,
            notification.document_status || null,
        ],
    );
}

/**
 * Updates the document_status for an existing notification.
 */
export async function updateNotificationDocumentStatus(
    userId: string,
    externalId: string,
    status: NonNullable<RawNotification['document_status']>,
): Promise<void> {
    const pool = getPool();
    await pool.query(
        `UPDATE notifications
         SET document_status = $3
         WHERE user_id = $1 AND external_id = $2`,
        [userId, externalId, status],
    );
}

// ─── Document Queries ────────────────────────────────────────────────────────

/**
 * Returns whether a file has already been uploaded to Drive for this user.
 */
export async function uploadedFileExists(userId: string, fileHash: string): Promise<boolean> {
    const pool = getPool();
    const res = await pool.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM uploaded_files WHERE user_id = $1 AND file_hash = $2',
        [userId, fileHash],
    );
    return parseInt(res.rows[0].count, 10) > 0;
}

/**
 * Inserts a record of a successfully uploaded file to Google Drive.
 */
export async function insertUploadedFile(
    userId: string,
    course: string,
    fileHash: string,
    filename: string,
    driveFileId: string,
): Promise<void> {
    const pool = getPool();
    await pool.query(
        `INSERT INTO uploaded_files (user_id, course, file_hash, filename, drive_file_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, file_hash) DO NOTHING`,
        [userId, course, fileHash, filename, driveFileId],
    );
}

export type { pg };
