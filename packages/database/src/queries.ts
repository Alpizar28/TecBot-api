import crypto from 'crypto';
import type pg from 'pg';
import { getPool } from './client.js';
import type { User, StoredNotification, RawNotification } from '@tec-brain/types';

const COURSE_CODE_RE = /^[A-Z]{2,4}\d{3,4}$/i;
const GENERIC_COURSE_LABELS = new Set([
  'hay una nueva noticia en el curso',
  'nueva noticia en el curso',
]);

export function normalizeCourseLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeCourseKey(value: string): string {
  return normalizeCourseLabel(value).toLowerCase();
}

function normalizeGenericCourseLabel(value: string): string {
  return normalizeCourseLabel(value)
    .replace(/[.:]+$/g, '')
    .trim()
    .toLowerCase();
}

function isGenericCourseLabel(value: string): boolean {
  return GENERIC_COURSE_LABELS.has(normalizeGenericCourseLabel(value));
}

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
       (user_id, external_id, type, course, title, description, link, hash, document_status, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      notification.date || null,
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

export async function listUserNotificationCourses(userId: string): Promise<string[]> {
  const pool = getPool();
  const res = await pool.query<{ course: string }>(
    'SELECT DISTINCT course FROM notifications WHERE user_id = $1 ORDER BY course',
    [userId],
  );
  return res.rows.map((row) => row.course).filter(Boolean);
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

// ─── Course Filters (Per-user mute list) ─────────────────────────────────────

export interface UserCourseFilter {
  user_id: string;
  course_key: string;
  course_label: string;
  created_at: Date;
}

export async function listUserCourseFilters(userId: string): Promise<UserCourseFilter[]> {
  const pool = getPool();
  const res = await pool.query<UserCourseFilter>(
    'SELECT * FROM user_course_filters WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  return res.rows;
}

export async function muteUserCourse(
  userId: string,
  courseKey: string,
  courseLabel: string,
): Promise<void> {
  const pool = getPool();
  const key = normalizeCourseKey(courseKey);
  const label = courseLabel.trim() || courseKey;
  await pool.query(
    `INSERT INTO user_course_filters (user_id, course_key, course_label)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, course_key) DO UPDATE
       SET course_label = CASE
         WHEN length($3) > length(user_course_filters.course_label) THEN $3
         ELSE user_course_filters.course_label
       END`,
    [userId, key, label],
  );
}

export async function unmuteUserCourse(userId: string, courseKey: string): Promise<void> {
  const pool = getPool();
  const key = normalizeCourseKey(courseKey);
  await pool.query('DELETE FROM user_course_filters WHERE user_id = $1 AND course_key = $2', [
    userId,
    key,
  ]);
}

export async function isCourseMuted(userId: string, courseKey: string): Promise<boolean> {
  const pool = getPool();
  const key = normalizeCourseKey(courseKey);
  const res = await pool.query(
    'SELECT 1 FROM user_course_filters WHERE user_id = $1 AND course_key = $2 LIMIT 1',
    [userId, key],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function isAnyCourseMuted(userId: string, courseKeys: string[]): Promise<boolean> {
  if (courseKeys.length === 0) return false;
  const pool = getPool();
  const normalizedKeys = [...new Set(courseKeys.map((key) => normalizeCourseKey(key)))];
  const res = await pool.query(
    'SELECT 1 FROM user_course_filters WHERE user_id = $1 AND course_key = ANY($2) LIMIT 1',
    [userId, normalizedKeys],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function unmuteUserCourses(userId: string, courseKeys: string[]): Promise<void> {
  if (courseKeys.length === 0) return;
  const pool = getPool();
  const normalizedKeys = [...new Set(courseKeys.map((key) => normalizeCourseKey(key)))];
  await pool.query('DELETE FROM user_course_filters WHERE user_id = $1 AND course_key = ANY($2)', [
    userId,
    normalizedKeys,
  ]);
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
  onedrive_root_folder_id?: string | null;
  storage_provider?: 'drive' | 'onedrive' | 'none';
}): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (
       name,
       tec_username,
       tec_password_enc,
       telegram_chat_id,
       drive_root_folder_id,
       onedrive_root_folder_id,
       storage_provider,
       is_active
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     RETURNING id`,
    [
      params.name,
      params.tec_username,
      params.tec_password_enc,
      params.telegram_chat_id,
      params.drive_root_folder_id,
      params.onedrive_root_folder_id ?? null,
      params.storage_provider ?? 'none',
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
    storage_provider?: 'drive' | 'onedrive' | 'none';
    onedrive_root_folder_id?: string | null;
  },
): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `UPDATE users
     SET tec_username = $2,
         tec_password_enc = $3,
         drive_root_folder_id = $4,
         onedrive_root_folder_id = COALESCE($5, onedrive_root_folder_id),
         storage_provider = COALESCE($6, storage_provider),
         is_active = TRUE
     WHERE telegram_chat_id = $1
     RETURNING id`,
    [
      chatId,
      params.tec_username,
      params.tec_password_enc,
      params.drive_root_folder_id,
      params.onedrive_root_folder_id ?? null,
      params.storage_provider ?? null,
    ],
  );
  if (res.rows.length === 0) {
    throw new Error('User not found or chat ID mismatch');
  }
  return res.rows[0].id;
}

export async function updateUserCredentials(
  chatId: string,
  tec_username: string,
  tec_password_enc: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users
     SET tec_username = $2,
         tec_password_enc = $3
     WHERE telegram_chat_id = $1`,
    [chatId, tec_username, tec_password_enc],
  );
}

export async function updateUserDriveFolder(
  chatId: string,
  drive_root_folder_id: string | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users
     SET drive_root_folder_id = $2
     WHERE telegram_chat_id = $1`,
    [chatId, drive_root_folder_id],
  );
}

export async function updateUserOneDriveFolder(
  chatId: string,
  onedrive_root_folder_id: string | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users
     SET onedrive_root_folder_id = $2
     WHERE telegram_chat_id = $1`,
    [chatId, onedrive_root_folder_id],
  );
}

export async function updateUserStorageProvider(
  chatId: string,
  storage_provider: 'drive' | 'onedrive' | 'none',
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users
     SET storage_provider = $2
     WHERE telegram_chat_id = $1`,
    [chatId, storage_provider],
  );
}

// ─── Pending Bot Registration Queries ────────────────────────────────────────

export type RegistrationStep =
  | 'awaiting_username'
  | 'awaiting_password'
  | 'awaiting_drive_folder'
  | 'awaiting_confirmation'
  | 'done'
  | 'update_awaiting_username'
  | 'update_awaiting_password'
  | 'update_awaiting_drive'
  | 'storage_awaiting_drive_folder'
  | 'storage_awaiting_onedrive_folder'
  | 'studyos_awaiting_url'
  | 'studyos_awaiting_token';

export interface PendingRegistration {
  id: string;
  chat_id: string;
  step: RegistrationStep;
  tec_username: string | null;
  tec_password_enc: string | null;
  drive_folder_id: string | null;
  onedrive_folder_id: string | null;
  studyos_url: string | null;
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
    `INSERT INTO pending_registrations (
       chat_id,
       step,
       tec_username,
       tec_password_enc,
       drive_folder_id,
       onedrive_folder_id,
       updated_at
     )
     VALUES ($1, 'awaiting_username', NULL, NULL, NULL, NULL, NOW())
     ON CONFLICT (chat_id) DO UPDATE
       SET step             = 'awaiting_username',
           tec_username     = NULL,
           tec_password_enc = NULL,
           drive_folder_id  = NULL,
           onedrive_folder_id = NULL,
           updated_at       = NOW()`,
    [chatId],
  );
}

export async function upsertPendingRegistrationWithStep(
  chatId: string,
  step: RegistrationStep,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO pending_registrations (
       chat_id,
       step,
       tec_username,
       tec_password_enc,
       drive_folder_id,
       onedrive_folder_id,
       updated_at
     )
     VALUES ($1, $2, NULL, NULL, NULL, NULL, NOW())
     ON CONFLICT (chat_id) DO UPDATE
       SET step             = $2,
           tec_username     = NULL,
           tec_password_enc = NULL,
           drive_folder_id  = NULL,
           onedrive_folder_id = NULL,
           updated_at       = NOW()`,
    [chatId, step],
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
    onedrive_folder_id?: string | null;
    studyos_url?: string | null;
  },
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE pending_registrations
     SET step             = $2,
         tec_username     = COALESCE($3, tec_username),
         tec_password_enc = COALESCE($4, tec_password_enc),
         drive_folder_id  = COALESCE($5, drive_folder_id),
         onedrive_folder_id = COALESCE($6, onedrive_folder_id),
         studyos_url      = COALESCE($7, studyos_url),
         updated_at       = NOW()
     WHERE chat_id = $1`,
    [
      chatId,
      step,
      data.tec_username ?? null,
      data.tec_password_enc ?? null,
      data.drive_folder_id ?? null,
      data.onedrive_folder_id ?? null,
      data.studyos_url ?? null,
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
 * Returns the encrypted OneDrive OAuth token JSON for a user, or null if not set.
 */
export async function getOneDriveOAuthToken(userId: string): Promise<string | null> {
  const pool = getPool();
  const res = await pool.query<{ onedrive_oauth_token_enc: string | null }>(
    'SELECT onedrive_oauth_token_enc FROM users WHERE id = $1',
    [userId],
  );
  return res.rows[0]?.onedrive_oauth_token_enc ?? null;
}

/**
 * Persists the encrypted OneDrive OAuth token JSON for a user.
 */
export async function saveOneDriveOAuthToken(
  userId: string,
  encryptedToken: string,
): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE users SET onedrive_oauth_token_enc = $2 WHERE id = $1', [
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
 * Consumes an OAuth state nonce, returning the associated userId if valid and not expired (10 min TTL).
 */
export async function consumeOAuthState(nonce: string): Promise<string | null> {
  const pool = getPool();
  const res = await pool.query<{ user_id: string }>(
    `DELETE FROM oauth_states
     WHERE state_nonce = $1
       AND created_at > NOW() - INTERVAL '10 minutes'
     RETURNING user_id`,
    [nonce],
  );
  return res.rows[0]?.user_id ?? null;
}

/**
 * Deletes all OAuth state nonces older than 1 hour.
 * Should be called periodically (e.g. every hour) to prevent table bloat.
 */
export async function purgeExpiredOAuthStates(): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM oauth_states
       WHERE created_at < NOW() - INTERVAL '1 hour'
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM deleted`,
  );
  return parseInt(res.rows[0]?.count ?? '0', 10);
}

// ─── Course Mappings ─────────────────────────────────────────────────────────

/**
 * Inserts or updates a global course code → full name mapping.
 * Code is stored in uppercase. If the mapping already exists, the name
 * is only updated when the new name is longer (richer information wins).
 */
export async function upsertCourseMapping(code: string, name: string): Promise<void> {
  const pool = getPool();
  const upper = code.toUpperCase();
  await pool.query(
    `INSERT INTO course_mappings (code, name, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (code) DO UPDATE
       SET name       = CASE WHEN length($2) > length(course_mappings.name) THEN $2 ELSE course_mappings.name END,
           updated_at = NOW()`,
    [upper, name],
  );
}

/**
 * Returns the stored full name for a course code, or null if unknown.
 */
export async function getCourseMapping(code: string): Promise<string | null> {
  const pool = getPool();
  const upper = code.toUpperCase();
  const res = await pool.query<{ name: string }>(
    'SELECT name FROM course_mappings WHERE code = $1',
    [upper],
  );
  return res.rows[0]?.name ?? null;
}

/**
 * Returns the stored course code for a full course name, or null if unknown.
 */
export async function getCourseCodeByName(name: string): Promise<string | null> {
  const pool = getPool();
  const normalized = normalizeCourseLabel(name);
  const res = await pool.query<{ code: string }>(
    'SELECT code FROM course_mappings WHERE lower(name) = lower($1) LIMIT 1',
    [normalized],
  );
  return res.rows[0]?.code ?? null;
}

export interface ResolvedCourseEntry {
  key: string;
  label: string;
  legacyKey: string;
  code: string | null;
  name: string | null;
  isUnknown: boolean;
}

/**
 * Builds a canonical key + label for course filters.
 */
export async function resolveCourseEntry(course: string): Promise<ResolvedCourseEntry> {
  const normalizedLabel = normalizeCourseLabel(course);
  const legacyKey = normalizeCourseKey(normalizedLabel);

  if (!normalizedLabel || isGenericCourseLabel(normalizedLabel)) {
    return {
      key: 'unknown',
      label: 'Curso desconocido',
      legacyKey,
      code: null,
      name: null,
      isUnknown: true,
    };
  }

  if (COURSE_CODE_RE.test(normalizedLabel)) {
    const code = normalizedLabel.toUpperCase();
    const mappedName = await getCourseMapping(code);
    const label = mappedName ? `${code} - ${mappedName}` : code;
    return {
      key: normalizeCourseKey(`code:${code}`),
      label,
      legacyKey,
      code,
      name: mappedName,
      isUnknown: false,
    };
  }

  const code = await getCourseCodeByName(normalizedLabel);
  if (code) {
    const mappedName = await getCourseMapping(code).catch(() => null);
    const name =
      mappedName && mappedName.length > normalizedLabel.length ? mappedName : normalizedLabel;
    return {
      key: normalizeCourseKey(`code:${code}`),
      label: `${code} - ${name}`,
      legacyKey,
      code,
      name,
      isUnknown: false,
    };
  }

  return {
    key: `name:${legacyKey}`,
    label: normalizedLabel,
    legacyKey,
    code: null,
    name: normalizedLabel,
    isUnknown: false,
  };
}

// ─── Admin Stats ─────────────────────────────────────────────────────────────

export interface AdminStats {
  activeUsers: number;
  storageBreakdown: { drive: number; onedrive: number; none: number };
  totalNotifications: number;
  totalUploadedFiles: number;
}

export async function getAdminStats(): Promise<AdminStats> {
  const pool = getPool();

  const [usersRes, notifRes, filesRes] = await Promise.all([
    pool.query<{ storage_provider: string; count: string }>(
      `SELECT storage_provider, COUNT(*)::text AS count FROM users WHERE is_active = TRUE GROUP BY storage_provider`,
    ),
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM notifications`),
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM uploaded_files`),
  ]);

  const breakdown = { drive: 0, onedrive: 0, none: 0 };
  let activeUsers = 0;
  for (const row of usersRes.rows) {
    const n = parseInt(row.count, 10);
    activeUsers += n;
    if (row.storage_provider === 'drive') breakdown.drive = n;
    else if (row.storage_provider === 'onedrive') breakdown.onedrive = n;
    else breakdown.none = n;
  }

  return {
    activeUsers,
    storageBreakdown: breakdown,
    totalNotifications: parseInt(notifRes.rows[0]?.count ?? '0', 10),
    totalUploadedFiles: parseInt(filesRes.rows[0]?.count ?? '0', 10),
  };
}

// ─── StudyOS Dispatch (delivery tracking + retry) ────────────────────────────

export interface StudyosPendingNotification {
  id: string;
  external_id: string;
  type: string;
  course: string;
  title: string;
  description: string | null;
  link: string | null;
  published_at: string | null;
}

export async function getNotificationId(
  userId: string,
  externalId: string,
): Promise<string | null> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    'SELECT id FROM notifications WHERE user_id = $1 AND external_id = $2 LIMIT 1',
    [userId, externalId],
  );
  return res.rows[0]?.id ?? null;
}

export async function markStudyosDelivered(notificationId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO studyos_dispatch (notification_id, delivered_at, attempts, last_error)
     VALUES ($1, now(), 1, NULL)
     ON CONFLICT (notification_id) DO UPDATE
       SET delivered_at = now(),
           attempts = studyos_dispatch.attempts + 1,
           last_error = NULL`,
    [notificationId],
  );
}

export interface StudyosFailurePolicy {
  /** Error definitivo (payload inválido, 404…): no volver a intentar nunca. */
  permanent?: boolean;
}

/**
 * Registra un fallo de entrega a StudyOS. El backoff exponencial se calcula
 * aquí (única fuente de verdad): 5 min · 2^attempts, tope 6 h. Los fallos
 * permanentes quedan fuera del retry para siempre.
 */
export async function recordStudyosFailure(
  notificationId: string,
  error: string,
  policy: StudyosFailurePolicy = {},
): Promise<void> {
  const pool = getPool();
  const permanent = policy.permanent ?? false;
  await pool.query(
    `INSERT INTO studyos_dispatch (notification_id, delivered_at, attempts, last_error, next_retry_at, permanent)
     VALUES ($1, NULL, 1, $2,
             CASE WHEN $3 THEN NULL ELSE now() + interval '5 minutes' END, $3)
     ON CONFLICT (notification_id) DO UPDATE
       SET attempts = studyos_dispatch.attempts + 1,
           last_error = $2,
           permanent = studyos_dispatch.permanent OR $3,
           next_retry_at = CASE
             WHEN studyos_dispatch.permanent OR $3 THEN NULL
             ELSE now() + LEAST(
               interval '6 hours',
               interval '5 minutes' * pow(2, LEAST(studyos_dispatch.attempts, 10))
             )
           END`,
    [notificationId, error.slice(0, 500), permanent],
  );
}

/**
 * Notifications not yet delivered to StudyOS (no dispatch row, or failed with
 * attempts under the cap). Limited to the last 14 days so enabling the
 * integration doesn't flood StudyOS with the full history.
 */
export async function getPendingStudyosNotifications(
  userId: string,
  maxAttempts = 10,
  limit = 25,
): Promise<StudyosPendingNotification[]> {
  const pool = getPool();
  const res = await pool.query<StudyosPendingNotification>(
    `SELECT n.id, n.external_id, n.type, n.course, n.title, n.description, n.link, n.published_at
       FROM notifications n
       LEFT JOIN studyos_dispatch d ON d.notification_id = n.id
      WHERE n.user_id = $1
        AND n.sent_at > now() - interval '14 days'
        AND (d.notification_id IS NULL
             OR (d.delivered_at IS NULL
                 AND d.attempts < $2
                 AND NOT d.permanent
                 AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())))
      ORDER BY n.sent_at
      LIMIT $3`,
    [userId, maxAttempts, limit],
  );
  return res.rows;
}

/** Estado de entregas a StudyOS de un usuario, para el comando /studyos. */
export interface StudyosDeliveryStats {
  delivered_24h: number;
  pending: number;
  failed_permanent: number;
  last_error: string | null;
  last_error_at: Date | null;
}

export async function getStudyosDeliveryStats(userId: string): Promise<StudyosDeliveryStats> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE d.delivered_at > now() - interval '24 hours')::int AS delivered_24h,
       COUNT(*) FILTER (WHERE d.delivered_at IS NULL AND NOT d.permanent
                          AND n.sent_at > now() - interval '14 days')::int AS pending,
       COUNT(*) FILTER (WHERE d.permanent)::int AS failed_permanent,
       (array_agg(d.last_error ORDER BY n.sent_at DESC)
          FILTER (WHERE d.delivered_at IS NULL AND d.last_error IS NOT NULL))[1] AS last_error,
       MAX(n.sent_at) FILTER (WHERE d.delivered_at IS NULL AND d.last_error IS NOT NULL) AS last_error_at
       FROM studyos_dispatch d
       JOIN notifications n ON n.id = d.notification_id
      WHERE n.user_id = $1`,
    [userId],
  );
  const row = res.rows[0] ?? {};
  return {
    delivered_24h: row.delivered_24h ?? 0,
    pending: row.pending ?? 0,
    failed_permanent: row.failed_permanent ?? 0,
    last_error: row.last_error ?? null,
    last_error_at: row.last_error_at ?? null,
  };
}

/** Configura (o reconfigura) el destino StudyOS de un usuario. */
export async function updateUserStudyos(
  chatId: string,
  studyosUrl: string,
  studyosTokenEnc: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users SET studyos_url = $2, studyos_token_enc = $3 WHERE telegram_chat_id = $1`,
    [chatId, studyosUrl, studyosTokenEnc],
  );
}

export async function clearUserStudyos(chatId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users SET studyos_url = NULL, studyos_token_enc = NULL WHERE telegram_chat_id = $1`,
    [chatId],
  );
}

// ─── Cycle Stats (último ciclo del orquestador, para /status) ────────────────

export interface CycleStatsRecord {
  started_at: Date;
  finished_at: Date;
  users_total: number;
  users_processed: number;
  users_failed: number;
  users_auth_failed: number;
  notifications_dispatched: number;
  notifications_processed: number;
  notifications_partial: number;
  dominant_error: string | null;
}

export async function saveCycleStats(stats: CycleStatsRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO cycle_stats (
       id, started_at, finished_at, users_total, users_processed, users_failed,
       users_auth_failed, notifications_dispatched, notifications_processed,
       notifications_partial, dominant_error
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       started_at = $1, finished_at = $2, users_total = $3, users_processed = $4,
       users_failed = $5, users_auth_failed = $6, notifications_dispatched = $7,
       notifications_processed = $8, notifications_partial = $9, dominant_error = $10`,
    [
      stats.started_at,
      stats.finished_at,
      stats.users_total,
      stats.users_processed,
      stats.users_failed,
      stats.users_auth_failed,
      stats.notifications_dispatched,
      stats.notifications_processed,
      stats.notifications_partial,
      stats.dominant_error,
    ],
  );
}

export async function getLastCycleStats(): Promise<CycleStatsRecord | null> {
  const pool = getPool();
  const res = await pool.query<CycleStatsRecord>('SELECT * FROM cycle_stats WHERE id = 1');
  return res.rows[0] ?? null;
}

// ─── Error Log (visibilidad operativa para /errores y /status) ───────────────

export interface ErrorLogEntry {
  user_id?: string | null;
  external_id?: string | null;
  notif_type?: string | null;
  action: string;
  error_message: string;
}

export async function insertErrorLog(entry: ErrorLogEntry): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO error_log (user_id, external_id, notif_type, action, error_message)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.user_id ?? null,
      entry.external_id ?? null,
      entry.notif_type ?? null,
      entry.action,
      entry.error_message.slice(0, 500),
    ],
  );
}

export interface ErrorGroup {
  action: string;
  error_message: string;
  count: number;
  last_at: Date;
  sample_external_id: string | null;
}

/** Errores de las últimas `hours` horas, agrupados por acción + mensaje. */
export async function getErrorSummary(hours: number, limit = 10): Promise<ErrorGroup[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT action, error_message, COUNT(*)::int AS count, MAX(occurred_at) AS last_at,
            (array_agg(external_id ORDER BY occurred_at DESC))[1] AS sample_external_id
       FROM error_log
      WHERE occurred_at > now() - make_interval(hours => $1)
      GROUP BY action, error_message
      ORDER BY MAX(occurred_at) DESC
      LIMIT $2`,
    [hours, limit],
  );
  return res.rows as ErrorGroup[];
}

export async function countRecentErrors(hours: number): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM error_log
      WHERE occurred_at > now() - make_interval(hours => $1)`,
    [hours],
  );
  return parseInt(res.rows[0]?.count ?? '0', 10);
}

export async function purgeOldErrors(days: number): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM error_log WHERE occurred_at < now() - make_interval(days => $1)`, [
    days,
  ]);
}

export type { pg };
