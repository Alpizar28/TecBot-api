# Alerts Runbook (API-Only)

## Alertas minimas
1. Login failures por usuario > 3 consecutivos.
2. `notifications_partial` por ciclo > umbral (`ALERT_PARTIAL_THRESHOLD_PCT`, default 20%).
3. `documents_resolved / documents_total` < 70%.
4. `uploads_failed` sostenido por 3 ciclos.
5. `users_failed` por ciclo >= umbral (`ALERT_USER_FAILURES_THRESHOLD`, default 1).

## Respuesta operativa
1. Revisar logs por `userId`, `externalId`, `component`.
2. Verificar salud de TEC endpoints internos.
3. Verificar validez de cookies/sesion.
4. Verificar Telegram y, para Drive, asumir que hoy no esta listo; cualquier alerta de upload debe tratarse como falla conocida hasta nuevo aviso.
5. Si impacto alto: activar rollback al release/tag anterior estable.

## Variables operativas
- `HTTP_RETRY_ATTEMPTS` (default: 3)
- `HTTP_RETRY_BASE_MS` (default: 400)
- `ALERT_PARTIAL_THRESHOLD_PCT` (default: 20)
- `ALERT_USER_FAILURES_THRESHOLD` (default: 1)
- `ADMIN_ALERT_CHAT_ID` (opcional, para enviar alertas por Telegram)

## Cierre de incidente
- Registrar causa raiz.
- Registrar cambio aplicado.
- Actualizar pruebas/heuristicas si aplica.
