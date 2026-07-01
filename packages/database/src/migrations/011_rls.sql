-- Migration 011: Permisos mínimos para el rol `tecbrain` (sin RLS)
--
-- Historia: una versión previa de esta migración habilitaba Row Level Security
-- en las tablas con datos de usuario, pero con policies `USING (true) WITH
-- CHECK (true)` para el único rol de la app (`tecbrain`). Eso NO aísla nada:
-- permite todas las filas igual, y daba una falsa sensación de seguridad.
-- La protección real es que cada query de la app filtra por `user_id = $1`.
--
-- Por eso revertimos la RLS aquí (deshabilitar + drop policies, idempotente,
-- porque las migraciones se re-corren en cada arranque) y conservamos solo los
-- GRANT de menor privilegio, que sí son útiles.
--
-- IMPORTANTE (pasos manuales, no forzados por esta migración):
--   ALTER ROLE tecbrain NOSUPERUSER NOCREATEDB NOCREATEROLE;  -- si aplica
--   ALTER ROLE tecbrain WITH PASSWORD '<contraseña-segura>';  -- antes de prod

-- ─── 1. Permisos mínimos para el rol tecbrain ────────────────────────────────
-- Solo DML (SELECT/INSERT/UPDATE/DELETE), sin DDL.

GRANT CONNECT ON DATABASE tecbrain TO tecbrain;
GRANT USAGE ON SCHEMA public TO tecbrain;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tecbrain;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tecbrain;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tecbrain;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tecbrain;

-- ─── 2. Revertir la RLS no-op de la versión anterior ─────────────────────────
-- Drop de las policies permisivas y disable de RLS en las tablas afectadas.
-- Idempotente y seguro aunque la RLS nunca se hubiera habilitado.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'notifications',
    'uploaded_files',
    'user_course_filters',
    'oauth_states',
    'pending_registrations'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tecbrain_all ON %I;', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
