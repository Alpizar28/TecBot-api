-- Migration 004: Create uploaded_files table to prevent duplicate Drive uploads
CREATE TABLE IF NOT EXISTS uploaded_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    filename TEXT NOT NULL,
    drive_file_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, file_hash)
);

CREATE INDEX IF NOT EXISTS uploaded_files_user_id_idx ON uploaded_files(user_id);
