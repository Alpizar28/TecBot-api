-- Migration 006: Pending bot registrations
-- Stores in-progress Telegram registration conversations

CREATE TABLE IF NOT EXISTS pending_registrations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id       TEXT NOT NULL UNIQUE,
    step          TEXT NOT NULL DEFAULT 'awaiting_username',
    tec_username  TEXT,
    tec_password_enc TEXT,
    drive_folder_id TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_reg_chat_id ON pending_registrations(chat_id);
