-- Seed: Initial users configuration
-- Replace encrypted passwords with actual values from the encrypt utility.
-- Run: node -e "const c=require('crypto');const k=process.env.DB_ENCRYPTION_KEY;..."

INSERT INTO users (name, tec_username, tec_password_enc, telegram_chat_id, drive_root_folder_id)
VALUES
  (
    'Pablo',
    'j.alpizar.1@estudiantec.cr',
    '__REPLACE_WITH_ENCRYPTED_PASSWORD__',
    '6317692621',
    '__REPLACE_WITH_DRIVE_FOLDER_ID__'
  ),
  (
    'Kembly',
    'k.garro.3@estudiantec.cr',
    '__REPLACE_WITH_ENCRYPTED_PASSWORD__',
    '8382334800',
    '__REPLACE_WITH_DRIVE_FOLDER_ID__'
  )
ON CONFLICT (tec_username) DO NOTHING;
