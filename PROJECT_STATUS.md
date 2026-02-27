# PROJECT STATUS - TEC Brain

Fecha de actualización: 2026-02-25

## Resumen Ejecutivo

`tec-brain` es un backend monorepo en TypeScript que automatiza la extracción de notificaciones académicas desde TEC Digital y las distribuye por Telegram y Google Drive.

El proyecto está funcional en producción (AWS + Docker) y actualmente realiza:
- Login automático al TEC Digital con sesiones persistentes por usuario (API-only JSON).
- Extracción de notificaciones (`noticia`, `evaluacion`, `documento`).
- Resolución de archivos de documentos (incluye estrategia para páginas Angular del TEC).
- Orquestación por cron y ejecución manual vía API.
- Deduplicación de notificaciones y archivos subidos.
- Subida de archivos a Google Drive (con OAuth de usuario o Service Account, según credencial).
- Envío de mensajes a Telegram (formato minimalista, incluyendo link directo a Drive para documentos subidos).

## Estado Actual (Operativo)

### Producción (AWS) - estado observado en esta sesión

- Infraestructura activa por Docker Compose en EC2.
- Contenedores principales:
  - `tec-brain-db` (PostgreSQL)
  - `tec-brain-scraper` (API-only scraper service)
  - `tec-brain-core` (orquestador + API + cron)
- Integración de Google Drive migrada a OAuth de usuario (para evitar el error de cuota de Service Account).
- Se validó ejecución manual del ciclo (`POST /api/run-now`).
- Se validó envío real de mensajes por Telegram con el formato nuevo.
- Se corrigió duplicación de carpetas de usuario/curso causada por condición de carrera al subir múltiples archivos.
- Se corrigió parsing del nombre de curso para usar nombres completos (mejor matching con carpetas existentes en Drive).

### Configuración funcional observada

- Usuarios activos en producción: 2 (Jose Pablo, Kembly Garro).
- Ambos usuarios apuntan al mismo `drive_root_folder_id` (carpeta raíz compartida) configurado en base de datos.
- Telegram bot funcionando y validado en producción.

## Objetivo del Sistema

Automatizar el flujo:
1. Revisar TEC Digital periódicamente.
2. Detectar cambios/notificaciones relevantes.
3. Enviar avisos por Telegram.
4. Descargar documentos nuevos del TEC.
5. Organizarlos en Google Drive por usuario y curso.
6. Evitar duplicados y reenvíos innecesarios.

## Arquitectura del Proyecto

```text
tec-brain/
├── apps/
│   ├── scraper/        # API de scraping (HTTP API-only + Fastify)
│   └── core/           # Orquestador (cron + dispatcher + API manual)
├── packages/
│   ├── types/          # Tipos compartidos (dominio + contratos API)
│   ├── database/       # Pool PG, migraciones, queries, crypto AES
│   ├── telegram/       # Cliente Telegram Bot API + formatters
│   └── drive/          # Cliente Google Drive API v3 (OAuth/SA)
├── scripts/
│   └── add-user.ts     # Alta/actualización de usuarios en DB
├── docker-compose.yml  # db + scraper + core
└── deploy.sh           # deploy por git pull + docker compose
```

## Tecnologías y Herramientas

### Lenguaje y runtime
- TypeScript
- Node.js 20+
- PNPM workspaces (monorepo)

### Backend / APIs
- Fastify (servicios `core` y `scraper`)
- @fastify/sensible
- Axios (HTTP cliente interno + Telegram + descarga de archivos TEC)

### Scraping / Extraccion API
- Axios + cookie jar (sin navegador)
- Sesiones persistidas en disco por usuario (cookies JSON)

### Base de datos
- PostgreSQL 15 (Docker)
- `pg` (node-postgres)
- Migraciones SQL versionadas

### Integraciones
- Telegram Bot API
- Google Drive API v3 (`googleapis`)
  - Soporte para Service Account
  - Soporte para OAuth Client + `token.json`

### Operación / Deploy
- Docker / Docker Compose
- AWS EC2 (producción observada)
- Script `deploy.sh` para pull + rebuild

### Calidad / Tooling
- ESLint
- Prettier
- Vitest (cobertura de tests todavía limitada)
- TSX (desarrollo / scripts)

## Servicios y Endpoints

## 1) `apps/scraper` (Scraper Service)

Servicio HTTP que recibe credenciales del usuario, inicia sesión en TEC Digital, extrae notificaciones y devuelve cookies de sesión + payload estructurado.

### Endpoints
- `GET /health`
  - Respuesta: estado básico del servicio.
- `POST /scrape/:userId`
  - Body: `{ username, password, keywords? }`
  - Respuesta: `ScrapeResponse`
    - `status`
    - `notifications[]`
    - `cookies[]`
    - `error?`

### Funcionalidades del scraper
- Reutiliza sesión (cookies) por usuario desde `SESSION_DIR`.
- Revalida sesión guardada antes de reloguearse.
- Hace login automático si la sesión expira.
- Extrae notificaciones por API interna de TEC Digital.
- Clasifica notificaciones en:
  - `noticia`
  - `evaluacion`
  - `documento`
- Para `documento`, resuelve archivos descargables por `folder-chunk` y fallback HTML.
- Devuelve cookies para que el `core` pueda descargar archivos autenticados.

## 2) `apps/core` (Core Orchestrator)

Servicio HTTP + cron que administra el ciclo completo de automatización.

### Endpoints
- `GET /health`
- `POST /api/run-now`
  - Dispara una ejecución manual del ciclo (asíncrona).

### Funcionalidades del core
- Ejecuta migraciones al arrancar.
- Programa ejecución periódica por cron (`CRON_SCHEDULE`).
- Ejecuta un ciclo inmediato al iniciar.
- Evita ejecuciones concurrentes del ciclo (`running` guard).
- Lee usuarios activos desde DB.
- Desencripta contraseñas de TEC por usuario.
- Llama al `scraper` por usuario.
- Despacha cada notificación por tipo (`dispatcher`).
- Registra errores estructurados en logs JSON.

## Flujo Funcional Completo (End-to-End)

1. `core` obtiene usuarios activos (`users.is_active = true`).
2. `core` desencripta `tec_password_enc` con `DB_ENCRYPTION_KEY`.
3. `core` llama `scraper` -> `POST /scrape/:userId`.
4. `scraper` reusa sesión o hace login en TEC.
5. `scraper` extrae notificaciones y posibles archivos.
6. `core` recibe `notifications + cookies`.
7. `dispatcher` aplica deduplicación de notificaciones.
8. Según tipo:
   - `noticia` -> Telegram
   - `evaluacion` -> Telegram
   - `documento` -> Drive + Telegram (o fallback)
9. Si es documento:
   - crea/usa carpeta de usuario en Drive (una vez por notificación)
   - crea/usa carpeta de curso (nombre completo)
   - descarga archivo desde TEC con cookies
   - sube a Drive
   - guarda registro en `uploaded_files`
   - envía mensaje Telegram con link directo al archivo en Drive
10. Persiste notificación procesada en DB.

## Funcionalidades Implementadas (Inventario Completo)

### A. Gestión de usuarios (DB)
- Alta de usuarios con script (`scripts/add-user.ts`).
- Actualización por `tec_username` (upsert).
- Activación/desactivación por columna `is_active`.
- Configuración de carpeta raíz de Drive por usuario (`drive_root_folder_id`).
- Almacenamiento de chat ID de Telegram por usuario.

### B. Seguridad de credenciales
- Contraseñas del TEC guardadas cifradas con AES-256-CBC (`iv:ciphertext`).
- Clave de cifrado controlada por `DB_ENCRYPTION_KEY` (64 hex).
- El `core` desencripta solo en runtime para llamar al scraper.

### C. Scraping TEC Digital
- Inicio de sesión automatizado.
- Reutilización de cookies persistentes por usuario.
- Validación de sesión antes de relogin.
- Manejo de errores de login (credenciales inválidas / transición fallida).
- Extracción de notificaciones desde panel web.
- Clasificación semántica por texto/clases CSS.
- Resolución de archivos de documentos usando datos de Angular (`isolateScope` / `scope`).
- Screenshots diagnósticos en casos de timeout de renderizado del TEC.
- Filtro opcional por keywords de curso (en endpoint scraper).

### D. Orquestación y concurrencia
- Cron configurable.
- Trigger manual por HTTP.
- Ejecución inmediata al startup.
- Límite de concurrencia entre usuarios (`CORE_CONCURRENCY`) con `p-limit`.
- Guard anti-solapamiento de ciclos (`Cycle already in progress`).

### E. Deduplicación y reintentos
- Deduplicación de notificaciones por `(user_id, external_id)`.
- Tracking de `document_status` (`resolved` / `unresolved`).
- Reprocesamiento de notificaciones de documento si antes estaban incompletas.
- Deduplicación de archivos subidos por hash (`download_url + file_name`).
- Tabla `uploaded_files` para evitar uploads duplicados.

### F. Google Drive (organización y subida)
- Soporte de autenticación con Service Account.
- Soporte de autenticación con OAuth Client + `token.json`.
- Búsqueda de carpeta por nombre + parent (`findFolder`).
- Creación de carpeta (`createFolder`).
- Garantía de existencia (`ensureFolder`).
- Descarga desde TEC con cookies y upload streaming a Drive.
- Organización por jerarquía:
  - carpeta raíz configurada por usuario (`drive_root_folder_id`)
  - carpeta de usuario (`user.name`)
  - carpeta de curso (`notification.course`, nombre completo)
- Corrección aplicada para evitar creación múltiple de carpetas por condición de carrera en notificaciones con varios archivos.

### G. Telegram (mensajería)
- Envío de mensajes HTML vía Bot API.
- Notificaciones para `noticia`.
- Notificaciones para `evaluacion`.
- Confirmación de documento guardado en Drive.
- Fallback a link del curso cuando falla upload a Drive.
- Formato actual minimalista (sin fecha).
- Link directo al archivo de Drive en mensajes de documento subido.

### H. Operación / DevOps
- `docker-compose.yml` con 3 servicios (`db`, `scraper`, `core`).
- Healthchecks para `db`, `scraper`, `core`.
- Volúmenes persistentes:
  - `postgres_data`
  - `sessions_data`
  - `drive_creds`
- `deploy.sh` para pull/rebuild/restart y seguimiento de logs.

## Contratos de Datos (Resumen)

### Tipos de notificación
- `noticia`
- `evaluacion`
- `documento`

### `RawNotification`
Campos principales:
- `external_id`
- `type`
- `course`
- `title`
- `description`
- `link`
- `date`
- `document_status?`
- `files?[]`

### `FileReference`
- `file_name`
- `download_url`
- `source_url`
- `mime_type?`

## Base de Datos (Esquema y propósito)

### `users`
Propósito: configuración por persona.

Campos clave:
- `tec_username`
- `tec_password_enc`
- `telegram_chat_id`
- `drive_root_folder_id`
- `is_active`

### `notifications`
Propósito: deduplicación y trazabilidad de notificaciones procesadas.

Campos clave:
- `user_id`
- `external_id` (único por usuario)
- `type`
- `course`
- `document_status`

### `uploaded_files`
Propósito: deduplicación de uploads a Drive.

Campos clave:
- `user_id`
- `file_hash` (único por usuario)
- `filename`
- `drive_file_id`

## Variables de Entorno (Principales)

### DB / Seguridad
- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `DB_ENCRYPTION_KEY`

### Integraciones
- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_DRIVE_CREDENTIALS_PATH`
- `GOOGLE_DRIVE_TOKEN_PATH` (opcional; para OAuth)

### Core
- `CRON_SCHEDULE`
- `CORE_CONCURRENCY`
- `SCRAPER_URL`

### Scraper
- `SESSION_DIR`
- `PORT`
- `HOST` (opcional)
- `LOG_LEVEL` (opcional)

## Estado de Calidad / Testing

### Qué existe
- Tests con Vitest en `apps/core/src/tests/orchestrator.test.ts`.
- Lint y format configurados a nivel monorepo.
- Tipado compartido por `packages/types`.

### Limitaciones actuales
- Cobertura de tests baja (principalmente mocks / smoke tests de formatter/dedupe).
- Faltan tests end-to-end de scraper + drive + telegram.
- Faltan pruebas de integración de DB (queries/migraciones) en CI.

## Riesgos / Deuda Técnica / Mejoras Recomendadas

### 1. Fragilidad del scraping
El scraper depende de selectores y estructuras Angular del TEC Digital, que pueden cambiar sin previo aviso.

Recomendado:
- snapshots de DOM/diagnóstico más estructurados
- métricas por tipo de fallo
- alertas cuando baja la tasa de extracción

### 2. Concurrencia de archivos (parcialmente mitigada)
Ya se corrigió la duplicación de carpetas por notificación, pero sigue existiendo trabajo paralelo por archivo en `Promise.allSettled`.

Recomendado:
- límites de concurrencia por archivo
- retries con backoff para errores de red/Drive

### 3. Observabilidad
Los logs son útiles, pero aún no hay métricas ni panel.

Recomendado:
- conteo por ciclo (notificaciones, archivos, errores)
- tiempos por usuario y por etapa
- dashboard simple (Prometheus/Grafana o logs estructurados centralizados)

### 4. Gestión de secretos
El proyecto maneja múltiples credenciales (TEC, Telegram, Google, DB encryption key).

Recomendado:
- secret manager (AWS SSM / Secrets Manager)
- política de rotación
- validación de `.env` al arranque

### 5. CI/CD
No se observa pipeline CI formal en el repo.

Recomendado:
- CI con lint + test
- build docker en PRs
- deploy automatizado con rollback básico

## Roadmap Sugerido (Pragmático)

### Corto plazo
- Mejorar tests del dispatcher (documentos con múltiples archivos y fallbacks).
- Añadir logs explícitos de archivo subido (usuario, curso, archivo, driveFileId).
- Documentar runbooks operativos (rotación OAuth token, recovery de sesiones).

### Mediano plazo
- Panel admin mínimo (usuarios, estado, último ciclo, últimas fallas).
- Reintentos configurables para Drive/Telegram.
- Filtro por curso por usuario (persistido en DB).

### Largo plazo
- CI/CD completo.
- Telemetría/alertas.
- Extracción más robusta si TEC expone endpoint estable o API interna usable.

## Comandos Útiles (Operación)

```bash
# Levantar stack completo
docker compose up -d --build

# Ver logs de orquestador
docker logs -f tec-brain-core

# Ver logs del scraper
docker logs -f tec-brain-scraper

# Disparar ciclo manual
curl -X POST http://localhost:3002/api/run-now

# Registrar / actualizar usuario
pnpm add-user "Nombre" "correo@estudiantec.cr" "password" "telegram_chat_id" "drive_root_folder_id"
```

## Conclusión

El proyecto está en una fase funcional y útil en producción: automatiza un flujo real end-to-end con scraping, notificaciones, almacenamiento y deduplicación. La base técnica es buena para seguir iterando. Las mejoras más importantes ahora están en observabilidad, pruebas e hardening del scraping.
