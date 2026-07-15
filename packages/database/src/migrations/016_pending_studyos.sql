-- Paso intermedio del flujo /studyos del bot: guarda la URL mientras se
-- espera el token (el token nunca se persiste aquí; se cifra directo en users).

ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS studyos_url TEXT;
