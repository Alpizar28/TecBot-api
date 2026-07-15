-- Política de reintentos del webhook StudyOS:
-- next_retry_at: backoff exponencial — el ciclo salta la fila hasta que venza.
-- permanent: error definitivo (payload inválido, 404...) — no se reintenta jamás.

ALTER TABLE studyos_dispatch ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE studyos_dispatch ADD COLUMN IF NOT EXISTS permanent BOOLEAN NOT NULL DEFAULT FALSE;
