-- Migration 009: Per-user course filters (mute list)

CREATE TABLE IF NOT EXISTS user_course_filters (
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_key   TEXT NOT NULL,
    course_label TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_course_filter UNIQUE (user_id, course_key)
);

CREATE INDEX IF NOT EXISTS idx_user_course_filters_user ON user_course_filters(user_id);
