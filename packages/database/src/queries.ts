import crypto from 'crypto';
import type pg from 'pg';
import { getPool } from './client.js';
import type { User, StoredNotification, RawNotification } from '@tec-brain/types';

// ─── User Queries ─────────────────────────────────────────────────────────────

export async function getActiveUsers(): Promise<User[]> {
  const pool = getPool();
  const res = await pool.query<User>(
    'SELECT * FROM users WHERE is_active = TRUE ORDER BY created_at',
  );
  return res.rows;
}

export async function getUserById(id: string): Promise<User | null> {
  const pool = getPool();
  const res = await pool.query<User>('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

export async function getUserByTelegramChatId(chatId: string): Promise<User | null> {
  const pool = getPool();
  const res = await pool.query<User>('SELECT * FROM users WHERE telegram_chat_id = $1', [chatId]);
  return res.rows[0] ?? null;
}

export async function getUserByTecUsername(username: string): Promise<User | null> {
  const pool = getPool();
  const res = await pool.query<User>('SELECT * FROM users WHERE tec_username = $1', [username]);
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

// ─── User Creation ────────────────────────────────────────────────────────────

/**
 * Creates a new user. Returns the new user's UUID.
 * On tec_username conflict, updates password, chat_id, and drive_folder_id.
 */
export async function createUser(params: {
  name: string;
  tec_username: string;
  tec_password_enc: string;
  telegram_chat_id: string;
  drive_root_folder_id: string | null;
}): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (name, tec_username, tec_password_enc, telegram_chat_id, drive_root_folder_id, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING id`,
    [
      params.name,
      params.tec_username,
      params.tec_password_enc,
      params.telegram_chat_id,
      params.drive_root_folder_id,
    ],
  );
  return res.rows[0].id;
}

export async function updateUser(
  chatId: string,
  params: {
    tec_username: string;
    tec_password_enc: string;
    drive_root_folder_id: string | null;
  },
): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `UPDATE users
     SET tec_username = $2,
         tec_password_enc = $3,
         drive_root_folder_id = $4,
         is_active = TRUE
     WHERE telegram_chat_id = $1
     RETURNING id`,
    [chatId, params.tec_username, params.tec_password_enc, params.drive_root_folder_id],
  );
  if (res.rows.length === 0) {
    throw new Error('User not found or chat ID mismatch');
  }
  return res.rows[0].id;
}

// ─── Pending Bot Registration Queries ────────────────────────────────────────

export type RegistrationStep =
  | 'awaiting_username'
  | 'awaiting_password'
  | 'awaiting_drive_folder'
  | 'awaiting_confirmation'
  | 'done';

export interface PendingRegistration {
  id: string;
  chat_id: string;
  step: RegistrationStep;
  tec_username: string | null;
  tec_password_enc: string | null;
  drive_folder_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Returns the in-progress registration for a Telegram chat_id, or null. */
export async function getPendingRegistration(chatId: string): Promise<PendingRegistration | null> {
  const pool = getPool();
  const res = await pool.query<PendingRegistration>(
    'SELECT * FROM pending_registrations WHERE chat_id = $1',
    [chatId],
  );
  return res.rows[0] ?? null;
}

/** Creates or resets a pending registration for a chat_id (step: awaiting_username). */
export async function upsertPendingRegistration(chatId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO pending_registrations (chat_id, step, tec_username, tec_password_enc, drive_folder_id, updated_at)
     VALUES ($1, 'awaiting_username', NULL, NULL, NULL, NOW())
     ON CONFLICT (chat_id) DO UPDATE
       SET step             = 'awaiting_username',
           tec_username     = NULL,
           tec_password_enc = NULL,
           drive_folder_id  = NULL,
           updated_at       = NOW()`,
    [chatId],
  );
}

/** Advances a pending registration to the next step. */
export async function advancePendingRegistration(
  chatId: string,
  step: RegistrationStep,
  data: {
    tec_username?: string;
    tec_password_enc?: string;
    drive_folder_id?: string | null;
  },
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE pending_registrations
     SET step             = $2,
         tec_username     = COALESCE($3, tec_username),
         tec_password_enc = COALESCE($4, tec_password_enc),
         drive_folder_id  = COALESCE($5, drive_folder_id),
         updated_at       = NOW()
     WHERE chat_id = $1`,
    [
      chatId,
      step,
      data.tec_username ?? null,
      data.tec_password_enc ?? null,
      data.drive_folder_id ?? null,
    ],
  );
}

/** Deletes a pending registration once the user is fully registered. */
export async function deletePendingRegistration(chatId: string): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM pending_registrations WHERE chat_id = $1', [chatId]);
}

// ─── Drive OAuth Token Queries ───────────────────────────────────────────────

/**
 * Returns the encrypted OAuth token JSON for a user, or null if not set.
 */
export async function getDriveOAuthToken(userId: string): Promise<string | null> {
  const pool = getPool();
  const res = await pool.query<{ drive_oauth_token_enc: string | null }>(
    'SELECT drive_oauth_token_enc FROM users WHERE id = $1',
    [userId],
  );
  return res.rows[0]?.drive_oauth_token_enc ?? null;
}

/**
 * Persists the encrypted OAuth token JSON for a user.
 */
export async function saveDriveOAuthToken(userId: string, encryptedToken: string): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE users SET drive_oauth_token_enc = $2 WHERE id = $1', [
    userId,
    encryptedToken,
  ]);
}

/**
 * Creates an OAuth state nonce for CSRF protection.
 */
export async function createOAuthState(userId: string): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ state_nonce: string }>(
    'INSERT INTO oauth_states (user_id) VALUES ($1) RETURNING state_nonce',
    [userId],
  );
  return res.rows[0].state_nonce;
}

/**
 * Consumes an OAuth state nonce, returning the associated userId if valid.
 */
export async function consumeOAuthState(nonce: string): Promise<string | null> {
  const pool = getPool();
  const res = await pool.query<{ user_id: string }>(
    'DELETE FROM oauth_states WHERE state_nonce = $1 RETURNING user_id',
    [nonce],
  );
  return res.rows[0]?.user_id ?? null;
}

export type { pg };
