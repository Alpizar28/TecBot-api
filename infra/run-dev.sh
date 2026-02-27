#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-tecbot-dev}"
DB_PORT="${DB_PORT:-5433}"
SCRAPER_PORT="${SCRAPER_PORT:-3003}"
CORE_PORT="${CORE_PORT:-3004}"

echo "==> Repo: $ROOT_DIR"
cd "$ROOT_DIR"

echo "==> Pulling latest changes"
git pull --ff-only

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "Missing $ROOT_DIR/.env"
  exit 1
fi

set -a
. "$ROOT_DIR/.env"
set +a

echo "==> Starting Docker stack"
echo "    project=$PROJECT_NAME db=$DB_PORT scraper=$SCRAPER_PORT core=$CORE_PORT"

COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
DB_PORT="$DB_PORT" \
SCRAPER_PORT="$SCRAPER_PORT" \
CORE_PORT="$CORE_PORT" \
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --build

echo "==> Services"
COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps
