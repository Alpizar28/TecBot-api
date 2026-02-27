# TEC Brain

Automatización académica para TEC Digital: extrae notificaciones y documentos por API interna, los envía por Telegram y guarda archivos en Google Drive.

## Qué hace

- Scrapea TEC Digital por API interna (sesiones HTTP persistentes por usuario).
- Detecta `noticias`, `evaluaciones` y `documentos`.
- Envía notificaciones a Telegram.
- Descarga documentos autenticados y los sube a Google Drive.
- Organiza archivos por usuario y curso.
- Evita duplicados (notificaciones y archivos).
- Permite ejecución por cron y trigger manual (`/api/run-now`).

## Arquitectura

```text
apps/
  core/      -> Orquestador (cron + dispatcher + API manual)
  scraper/   -> Scraper HTTP API-only (Fastify)
packages/
  database/  -> DB, migraciones, queries, crypto AES
  drive/     -> Integración Google Drive (OAuth o Service Account)
  telegram/  -> Integración Telegram Bot API
  types/     -> Tipos compartidos
```

## Stack tecnológico

- TypeScript + Node.js 20+
- Fastify
- Axios + cookie jar (sesiones HTTP)
- PostgreSQL
- Google Drive API v3 (`googleapis`)
- Telegram Bot API
- Docker / Docker Compose
- PNPM workspaces

## Requisitos

- Node.js >= 20
- pnpm >= 9
- Docker + Docker Compose
- Cuenta de Telegram (bot token)
- Credenciales Google Drive (OAuth o Service Account)

## Configuración rápida

### 1. Instalar dependencias

```bash
pnpm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Variables clave:
- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `DB_ENCRYPTION_KEY`
- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_DRIVE_CREDENTIALS_PATH`
- `CRON_SCHEDULE`
- `CORE_CONCURRENCY`
- `SCRAPER_URL`
- `HTTP_RETRY_ATTEMPTS`
- `HTTP_RETRY_BASE_MS`
- `ALERT_PARTIAL_THRESHOLD_PCT`
- `ALERT_USER_FAILURES_THRESHOLD`
- `ADMIN_ALERT_CHAT_ID` (opcional, alertas Telegram de operación)
- `SESSION_DIR`

Generar `DB_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Credenciales de Google Drive

El proyecto soporta dos modos:

#### Opción A: OAuth (recomendado para Drive personal)
- `credentials.json` con OAuth Client (`installed` o `web`)
- `token.json` con refresh token en la misma carpeta (o usar `GOOGLE_DRIVE_TOKEN_PATH`)

#### Opción B: Service Account
- `credentials.json` tipo `service_account`
- Requiere usar carpeta compartida/Shared Drive o permisos adecuados

> Nota: Para cuentas personales, OAuth suele evitar el error de cuota de Service Account.

## Levantar en local con Docker

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

Servicios:
- `db` -> PostgreSQL (`:5432`)
- `scraper` -> API scraper (`:3001`)
- `core` -> Orquestador + API (`:3002`)

## Desarrollo (sin levantar todo el compose)

### Solo DB por Docker + apps en local

```bash
docker compose -f infra/docker-compose.yml up -d db
pnpm dev:scraper
pnpm dev:core
```

## Endpoints

### Core (`apps/core`)
- `GET /health`
- `POST /api/run-now` -> dispara una corrida manual

### Scraper (`apps/scraper`)
- `GET /health`
- `POST /process-sequential/:userId`

Ejemplo trigger manual:

```bash
curl -X POST http://localhost:3002/api/run-now
```

## Alta / actualización de usuarios

Script helper:

```bash
pnpm add-user "Nombre" "correo@estudiantec.cr" "passwordTEC" "telegram_chat_id" "drive_root_folder_id"
```

Qué hace:
- cifra la contraseña del TEC (AES-256-CBC)
- inserta usuario nuevo o actualiza uno existente por `tec_username`

## Estructura de datos en Drive

Bajo `drive_root_folder_id`, el sistema organiza:

```text
<Drive Root>
└── <Nombre del usuario>
    └── <Nombre completo del curso>
        ├── archivo1.pdf
        └── archivo2.pdf
```

## Telegram (formato actual)

Mensajes minimalistas:
- curso (negrita)
- descripción o nombre del archivo
- link corto

Para documentos subidos, envía link directo al archivo de Drive.

## Deduplicación (importante)

El sistema evita duplicados en dos niveles:

- `notifications` -> no reenvía la misma notificación por usuario
- `uploaded_files` -> no resube el mismo archivo por usuario

Si borras archivos en Drive y quieres reprocesar documentos viejos, también debes limpiar estas tablas en PostgreSQL.

## Logs y monitoreo básico

```bash
docker logs -f tec-brain-core
docker logs -f tec-brain-scraper
```

El core también registra:
- métricas por endpoint (`Endpoint metrics`)
- métricas por ciclo (`Cycle metrics`)
- alertas automáticas cuando se superan umbrales (`Automatic cycle alerts triggered`)

## Scripts útiles

```bash
pnpm build
pnpm test
pnpm lint
pnpm format
```

## Deploy (script incluido)

```bash
./infra/deploy.sh
```

El script hace:
- `git pull origin main`
- `docker compose -f infra/docker-compose.yml up -d --build`
- stream de logs de `core`

## Documentación de estado del proyecto

Ver reporte amplio en:
- `docs/status/PROJECT_STATUS.md`

## Limitaciones conocidas

- El scraping depende de endpoints internos de TEC Digital (pueden cambiar sin previo aviso).
- Cobertura de tests aún en expansión.
- No hay CI/CD formal en el repo actualmente.

## Licencia

Uso interno / proyecto privado (ajustar según necesidad).
