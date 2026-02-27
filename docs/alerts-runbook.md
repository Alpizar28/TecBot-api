# Alerts Runbook (API-Only)

## Alertas minimas
1. Login failures por usuario > 3 consecutivos.
2. `notifications_partial` por ciclo > 20%.
3. `documents_resolved / documents_total` < 70%.
4. `uploads_failed` sostenido por 3 ciclos.

## Respuesta operativa
1. Revisar logs por `userId`, `externalId`, `component`.
2. Verificar salud de TEC endpoints internos.
3. Verificar validez de cookies/sesion.
4. Verificar conectividad Drive/Telegram.
5. Si impacto alto: activar rollback al release/tag anterior estable.

## Cierre de incidente
- Registrar causa raiz.
- Registrar cambio aplicado.
- Actualizar pruebas/heuristicas si aplica.
