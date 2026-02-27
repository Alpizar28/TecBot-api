-- Migration 001: Initial schema
-- Run once on first deploy

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    tec_username        TEXT NOT NULL UNIQUE,
    tec_password_enc    TEXT NOT NULL,              -- AES-256 encrypted via app
    telegram_chat_id    TEXT NOT NULL,
    drive_root_folder_id TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id             TEXT NOT NULL,
    type                    TEXT NOT NULL CHECK (type IN ('noticia', 'evaluacion', 'documento')),
    course                  TEXT NOT NULL,
    title                   TEXT NOT NULL,
    description             TEXT,
    link                    TEXT,
    hash                    TEXT NOT NULL,
    sent_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_notification UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type  ON notifications(type);
