-- Último ciclo del orquestador, persistido para que el bot pueda responder
-- /status sin acceso a la memoria del core. Fila única (id = 1, upsert).

CREATE TABLE IF NOT EXISTS cycle_stats (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  users_total INT NOT NULL,
  users_processed INT NOT NULL,
  users_failed INT NOT NULL,
  users_auth_failed INT NOT NULL,
  notifications_dispatched INT NOT NULL,
  notifications_processed INT NOT NULL,
  notifications_partial INT NOT NULL,
  dominant_error TEXT
);
