-- Migration 005: Per-user Google Drive OAuth tokens
-- Stores the encrypted OAuth2 token JSON (access_token, refresh_token, expiry_date)
-- so each user can authorize with their own Google account.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS drive_oauth_token_enc TEXT;
