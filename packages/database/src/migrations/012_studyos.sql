-- StudyOS integration: per-user webhook destination + delivery tracking.
-- users.studyos_url: base URL of the user's StudyOS instance (e.g. https://study.alpizar.dev)
-- users.studyos_token_enc: encrypted bearer token for /api/sync/* (same crypto as tec_password_enc)
-- notifications.published_at: feed date (was parsed but never persisted)
-- studyos_dispatch: delivery state per notification, retried by the cron cycle

ALTER TABLE users ADD COLUMN IF NOT EXISTS studyos_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS studyos_token_enc TEXT;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS published_at TEXT;

CREATE TABLE IF NOT EXISTS studyos_dispatch (
  notification_id UUID PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT
);
