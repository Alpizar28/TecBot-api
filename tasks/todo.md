# Plan: Sync upstream repo and run initialization

1. [x] Review current git status to ensure workspace readiness.
2. [x] Add/fetch from https://github.com/Alpizar28/TecBot-api as needed and pull its latest changes.
3. [x] Execute the `/init` command requested by the user and capture any relevant output or follow-ups.

# Plan: Document repo guidance for agents

1. [x] Review repository for existing AGENTS/Cursor/Copilot rule files and note their directives.
2. [x] Identify authoritative build/lint/test commands, including how to run single tests.
3. [x] Draft a ~150-line `AGENTS.md` consolidating commands and coding guidelines for future agents.

# Plan: Restore production cookies via Coolify host

1. [x] Inspect local session refresh logic to understand current cookie reuse constraints.
2. [x] SSH into Coolify host, list Docker services, and inspect scraper/core logs for cookie failures. _(Updated host/IP unlocked; confirmed docker container names/logs.)_
3. [x] Design/implement automatic cookie refresh changes plus deployment steps as needed.

# Plan: Simplify Drive folder hierarchy

1. [x] Update dispatcher logic so course folders are created directamente dentro de `drive_root_folder_id` sin subcarpeta con el nombre del usuario.
2. [x] Ajustar documentación (`README.md`, `AGENTS.md` u otros) para reflejar la nueva estructura.
3. [x] Verificar/lint/testear lo necesario y resumir los cambios para despliegue automático en Coolify.

# Plan: Notificar expiración de tokens de Drive

1. [x] Analizar flujo actual de errores Drive y decidir criterio para `invalid_grant`/401.
2. [x] Implementar alerta (Telegram/admin) cuando se detecte expiración y evitar spam.
3. [x] Añadir pruebas/documentación y validar con suite core.

# Plan: Filtros de cursos y comunidades en Telegram

1. [x] Definir esquema de filtros por usuario y migracion SQL.
2. [x] Agregar queries en packages/database para silenciar y listar cursos.
3. [x] Aplicar filtro en dispatcher para omitir Telegram y Drive.
4. [x] Implementar comando /filtros con menu y paginacion en el bot.
5. [x] Actualizar tests de dispatcher y documentar resultado.

## Review

- [ ] Cambios revisados y verificados
- [ ] Tests: `pnpm --filter @tec-brain/core test -- --run tests/dispatcher.test.ts` (fallo: pnpm no esta instalado)
