-- Migration 007: OAuth CSRF States
-- Stores nonces for Google Drive OAuth flow to prevent CSRF and State Injection

CREATE TABLE IF NOT EXISTS oauth_states (
    state_nonce   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delete states older than 1 hour to prevent buildup
-- This can be run periodically, but for now just the table is enough.
