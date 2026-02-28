# Deploy y Prueba en Ubuntu (Docker)

Esta guía deja `TecBot-api` corriendo en un servidor Ubuntu usando Docker Compose, y valida el flujo disponible hoy. La subida a Google Drive sigue sin funcionar, así que la validación debe centrarse en scraping y Telegram.

## 1) Requisitos en Ubuntu

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER
newgrp docker
```

Verificar:

```bash
docker --version
docker compose version
```

## 2) Clonar el proyecto

```bash
git clone https://github.com/Alpizar28/TecBot-api.git
cd TecBot-api
```

## 3) Configurar entorno

```bash
cp .env.example .env
nano .env
```

Variables mínimas a definir:
- `POSTGRES_PASSWORD`
- `DATABASE_URL` (si usas compose: `postgresql://tecbrain:<POSTGRES_PASSWORD>@db:5432/tecbrain`)
- `DB_ENCRYPTION_KEY` (64 hex)
- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_DRIVE_CREDENTIALS_PATH`
- `CRON_SCHEDULE`
- `CORE_CONCURRENCY`
- `SCRAPER_URL` (`http://scraper:3001`)
- `SESSION_DIR` (`./data/sessions`)

Variables recomendadas:
- `HTTP_RETRY_ATTEMPTS=3`
- `HTTP_RETRY_BASE_MS=400`
- `ALERT_PARTIAL_THRESHOLD_PCT=20`
- `ALERT_USER_FAILURES_THRESHOLD=1`
- `ADMIN_ALERT_CHAT_ID` (opcional, alertas a Telegram admin)

Generar clave de cifrado:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4) Credenciales de Google Drive

```bash
mkdir -p data/credentials
```

Coloca en esa carpeta:
- `credentials.json`
- `token.json` (si usas OAuth)

Y en `.env`:

```env
GOOGLE_DRIVE_CREDENTIALS_PATH=./data/credentials/credentials.json
```

## 5) Levantar servicios

```bash
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml ps
```

## 6) Health checks

```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
```

Esperado: `status: ok` en ambos.

## 7) Registrar usuario

Para usar `pnpm add-user`, necesitas Node+pnpm en el host:

```bash
sudo apt install -y nodejs npm
sudo npm i -g pnpm
pnpm install
pnpm add-user "Tu Nombre" "correo@estudiantec.cr" "clave_tec" "telegram_chat_id" "drive_root_folder_id"
```

## 8) Ejecutar prueba manual del ciclo

```bash
curl -X POST http://localhost:3002/api/run-now
```

## 9) Revisar logs

```bash
docker compose -f infra/docker-compose.yml logs -f core
docker compose -f infra/docker-compose.yml logs -f scraper
```

En `core`, validar:
- `Cycle metrics`
- `Endpoint metrics`
- `Automatic cycle alerts triggered` (solo si supera umbrales)

## 10) Criterio de prueba exitosa

- Llega mensaje a Telegram.
- Si hay documentos, hoy se espera fallback por Telegram; no se debe considerar obligatorio que se suban a Drive.
- No hay fallos repetitivos de login/sesión.
- No hay borrado en TEC cuando `processed=false`.

## 11) Comandos útiles

Reiniciar:

```bash
docker compose -f infra/docker-compose.yml restart
```

Apagar:

```bash
docker compose -f infra/docker-compose.yml down
```

Rebuild:

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

## 12) Troubleshooting rápido

### Error de conexión a DB
- Revisa `DATABASE_URL` y `POSTGRES_PASSWORD`.
- Verifica contenedor `db` en `docker compose ps`.

### No sube a Drive
- Estado actual conocido: la subida a Drive todavía no funciona de forma confiable.
- Verifica ruta y formato de `credentials.json`.
- Si OAuth, confirma `token.json` válido.
- Aunque las credenciales estén bien, puede seguir fallando hasta que se corrija la integración.

### No envía Telegram
- Verifica `TELEGRAM_BOT_TOKEN`.
- Verifica que el bot tenga permiso para escribir al `chat_id`.

### No aparecen notificaciones
- Revisa credenciales TEC del usuario.
- Revisa logs del `scraper` para `session/login` y endpoints TEC.
