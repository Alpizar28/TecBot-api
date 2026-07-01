-- Seed: Initial users configuration
-- Replace encrypted passwords with actual values from the encrypt utility.
-- Run: node -e "const c=require('crypto');const k=process.env.DB_ENCRYPTION_KEY;..."

-- NOTE: This is a manual template, not auto-run (runMigrations skips *seed* files).
-- Do NOT commit real names, emails, chat IDs or credentials here. Prefer the
-- `pnpm add-user` script, which encrypts the TEC password for you.

INSERT INTO users (name, tec_username, tec_password_enc, telegram_chat_id, drive_root_folder_id)
VALUES
  (
    '__NAME__',
    '__TEC_USERNAME__@estudiantec.cr',
    '__REPLACE_WITH_ENCRYPTED_PASSWORD__',
    '__TELEGRAM_CHAT_ID__',
    '__REPLACE_WITH_DRIVE_FOLDER_ID__'
  )
ON CONFLICT (tec_username) DO NOTHING;
