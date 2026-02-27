-- Migration 003: Add document_status tracking
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS document_status TEXT CHECK (document_status IN ('resolved', 'unresolved'));
