-- Durable alert state prevents false recoveries after a core restart and lets
-- the orchestrator debounce intermittent failures across cycles.
CREATE TABLE IF NOT EXISTS admin_alert_state (
  alert_key TEXT PRIMARY KEY,
  is_firing BOOLEAN NOT NULL DEFAULT false,
  failure_streak INT NOT NULL DEFAULT 0 CHECK (failure_streak >= 0),
  recovery_streak INT NOT NULL DEFAULT 0 CHECK (recovery_streak >= 0),
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
