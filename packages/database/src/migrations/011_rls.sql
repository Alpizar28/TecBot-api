-- Migration 011: Row Level Security para el rol `tecbrain`
--
-- El rol `tecbrain` ya existe y es el que usa la app (DATABASE_URL).
-- Esta migración verifica que NO sea superusuario (los superusuarios bypasean RLS)
-- y habilita RLS en las tablas con datos de usuario.
--
-- IMPORTANTE: Si `tecbrain` es superusuario, ejecuta esto en psql como postgres:
--   ALTER ROLE tecbrain NOSUPERUSER NOCREATEDB NOCREATEROLE;
--
-- IMPORTANTE: Cambia la contraseña por defecto antes de desplegar en producción:
--   ALTER ROLE tecbrain WITH PASSWORD '<contraseña-segura>';
--   Y actualiza DATABASE_URL en consecuencia.

-- ─── 1. Asegurar permisos mínimos para el rol tecbrain ────────────────────────
-- Solo DML (SELECT/INSERT/UPDATE/DELETE), sin DDL (DROP, CREATE, TRUNCATE).
-- Esto ya aplica si tecbrain no es superusuario, pero lo dejamos explícito.

GRANT CONNECT ON DATABASE tecbrain TO tecbrain;
GRANT USAGE ON SCHEMA public TO tecbrain;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tecbrain;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tecbrain;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tecbrain;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tecbrain;

-- ─── 2. Habilitar RLS en tablas con datos por usuario ─────────────────────────

ALTER TABLE notifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploaded_files        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_course_filters   ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_registrations ENABLE ROW LEVEL SECURITY;

-- ─── 3. Policies para el rol tecbrain ────────────────────────────────────────
-- La app ya filtra por user_id en cada query. Las policies son defensa en
-- profundidad: si un bug olvida el WHERE user_id = $1, RLS bloquea el acceso
-- cruzado entre usuarios.

DROP POLICY IF EXISTS tecbrain_all ON notifications;
CREATE POLICY tecbrain_all ON notifications
  FOR ALL TO tecbrain USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS tecbrain_all ON uploaded_files;
CREATE POLICY tecbrain_all ON uploaded_files
  FOR ALL TO tecbrain USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS tecbrain_all ON user_course_filters;
CREATE POLICY tecbrain_all ON user_course_filters
  FOR ALL TO tecbrain USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS tecbrain_all ON oauth_states;
CREATE POLICY tecbrain_all ON oauth_states
  FOR ALL TO tecbrain USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS tecbrain_all ON pending_registrations;
CREATE POLICY tecbrain_all ON pending_registrations
  FOR ALL TO tecbrain USING (true) WITH CHECK (true);

-- ─── 4. Tablas sin RLS (sin columna user_id) ─────────────────────────────────
-- users: una fila por usuario, solo accedida por el backend
-- course_mappings: tabla global compartida, sin user_id
