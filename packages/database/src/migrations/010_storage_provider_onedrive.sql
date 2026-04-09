-- Migration 010: Storage provider + OneDrive support

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'none'
    CHECK (storage_provider IN ('drive', 'onedrive', 'none')),
    ADD COLUMN IF NOT EXISTS onedrive_root_folder_id TEXT,
    ADD COLUMN IF NOT EXISTS onedrive_oauth_token_enc TEXT;

UPDATE users
SET storage_provider = 'drive'
WHERE storage_provider = 'none' AND drive_root_folder_id IS NOT NULL;

ALTER TABLE pending_registrations
    ADD COLUMN IF NOT EXISTS onedrive_folder_id TEXT;
