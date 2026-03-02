export { getPool, closePool } from './client.js';
export {
  getActiveUsers,
  getUserById,
  createUser,
  notificationExists,
  getNotificationState,
  insertNotification,
  updateNotificationDocumentStatus,
  uploadedFileExists,
  insertUploadedFile,
  getDriveOAuthToken,
  saveDriveOAuthToken,
  getPendingRegistration,
  upsertPendingRegistration,
  advancePendingRegistration,
  deletePendingRegistration,
  type PendingRegistration,
  type RegistrationStep,
} from './queries.js';
export { runMigrations } from './migrate.js';
export { encrypt, decrypt } from './crypto.js';
