-- Registro persistente de errores operativos (dispatch, scrape, forwards).
-- Antes solo existían en el stdout del contenedor; ahora el bot puede
-- responder /errores y /status sin acceso a docker logs. Retención corta:
-- el core purga filas de más de 14 días al inicio de cada ciclo.

CREATE TABLE IF NOT EXISTS error_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID,
  external_id TEXT,
  notif_type TEXT,
  action TEXT NOT NULL,
  error_message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS error_log_occurred_at_idx ON error_log (occurred_at);
