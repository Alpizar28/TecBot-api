-- Disable all cloud storage. Telegram remains the sole document delivery path.
-- Legacy columns remain to keep historical migrations and rollback safe.
UPDATE users
SET storage_provider = 'none',
    drive_root_folder_id = NULL,
    drive_oauth_token_enc = NULL,
    onedrive_root_folder_id = NULL,
    onedrive_oauth_token_enc = NULL
WHERE storage_provider <> 'none'
   OR drive_root_folder_id IS NOT NULL
   OR drive_oauth_token_enc IS NOT NULL
   OR onedrive_root_folder_id IS NOT NULL
   OR onedrive_oauth_token_enc IS NOT NULL;

UPDATE pending_registrations
SET drive_folder_id = NULL,
    onedrive_folder_id = NULL
WHERE drive_folder_id IS NOT NULL OR onedrive_folder_id IS NOT NULL;
