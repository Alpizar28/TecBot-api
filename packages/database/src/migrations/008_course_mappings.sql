-- Migration 008: Global course code → full name mappings
-- Shared across all users. Once we learn a course's full name,
-- we remember it permanently and use it for folder naming in Drive.

CREATE TABLE IF NOT EXISTS course_mappings (
    code        TEXT PRIMARY KEY,          -- e.g. "FI2207" (always uppercase)
    name        TEXT NOT NULL,             -- e.g. "Física General II"
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
