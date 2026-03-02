export { getPool, closePool } from './client.js';
export {
  getActiveUsers,
  getUserById,
  getUserByTelegramChatId,
  getUserByTecUsername,
  createUser,
  updateUser,
  notificationExists,
  getNotificationState,
  insertNotification,
  updateNotificationDocumentStatus,
  uploadedFileExists,
  insertUploadedFile,
  getDriveOAuthToken,
  saveDriveOAuthToken,
  createOAuthState,
  consumeOAuthState,
  getPendingRegistration,
  upsertPendingRegistration,
  advancePendingRegistration,
  deletePendingRegistration,
  type PendingRegistration,
  type RegistrationStep,
} from './queries.js';
export { runMigrations } from './migrate.js';
export { encrypt, decrypt } from './crypto.js';
