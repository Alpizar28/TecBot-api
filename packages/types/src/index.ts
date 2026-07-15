// ─── Domain Enums ─────────────────────────────────────────────────────────────

export type NotificationType = 'noticia' | 'evaluacion' | 'documento';

// ─── Domain Models ────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  tec_username: string;
  tec_password_enc: string;
  telegram_chat_id: string;
  drive_root_folder_id: string | null;
  onedrive_root_folder_id: string | null;
  storage_provider: 'drive' | 'onedrive' | 'none';
  /** Base URL of the user's StudyOS instance (null = StudyOS forwarding disabled) */
  studyos_url: string | null;
  /** Encrypted bearer token for StudyOS /api/sync/* (same crypto as tec_password_enc) */
  studyos_token_enc: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface FileReference {
  file_name: string;
  download_url: string;
  source_url: string;
  mime_type?: string;
}

export interface RawNotification {
  external_id: string;
  type: NotificationType;
  course: string;
  title: string;
  description: string;
  link: string;
  /** Direct URL to the specific news item page (only set for resolved news notifications) */
  resolved_link?: string;
  date: string;
  document_status?: 'resolved' | 'unresolved';
  files?: FileReference[];
}

export interface StoredNotification {
  id: string;
  user_id: string;
  external_id: string;
  type: NotificationType;
  course: string;
  title: string;
  description: string | null;
  link: string | null;
  hash: string;
  sent_at: Date;
  document_status?: 'resolved' | 'unresolved' | null;
}

// ─── Scraper API Contracts ────────────────────────────────────────────────────

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface ScrapeRequest {
  include_documents?: boolean;
}

export interface ScrapeResponse {
  status: 'success' | 'error';
  user_id: string;
  notifications: RawNotification[];
  cookies: Cookie[];
  error?: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AppConfig {
  port: number;
  databaseUrl: string;
  scraperBaseUrl: string;
  telegramBotToken: string;
  googleCredentialsPath: string;
  cronSchedule: string;
  sessionDir: string;
  encryptionKey: string;
}
