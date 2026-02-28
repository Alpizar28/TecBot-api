# API-Only Progress Ledger (32/32)

Fecha: 2026-02-27
Estado: Completado en codigo/documentacion para el flujo API-only base. La integracion con Drive no esta lista y no debe considerarse operativa.

## Mejoras posteriores (2026-02-27)
- Reintentos HTTP con backoff+jitter en scraper/core/drive.
- Metricas por endpoint agregadas en logs estructurados.
- Alertas automaticas de ciclo por umbral (opcionalmente enviadas a Telegram admin).

## Evidencia resumida por paso
1. Matriz de paridad creada: `docs/parity-matrix.md`.
2. Dataset canonico creado: `apps/scraper/tests/fixtures/canonical-notifications.json`.
3. Baseline KPI creado: `docs/baseline-metrics.md`.
4. Criterios de aceptacion creados: `docs/acceptance-criteria.md`.
5. Contratos estabilizados y consumidos por flujo API-only: `packages/types/src/index.ts`.
6. Trazabilidad document status activa en queries/migraciones existentes: `packages/database/src/queries.ts` + migrations 003/004.
7. Dispatch interno con `processed`: `apps/core/src/index.ts`, `apps/core/src/orchestrator.ts`, `apps/core/src/dispatcher.ts`.
8. Reglas de dedupe documentadas: `docs/dedup-rules.md`.
9. Login JSON robusto con retry: `apps/scraper/src/clients/tec-http.client.ts`.
10. Verificacion real de sesion: `apps/scraper/src/clients/tec-http.client.ts`.
11. Cuarentena de session JSON corrupto: `apps/scraper/src/sessions/session-manager.ts`.
12. Relogin transparente por expiracion: `apps/scraper/src/sessions/session-manager.ts`.
13. Fetch consolidado por APIs internas: `apps/scraper/src/extractors/notifications.ts`.
14. Heuristicas de tipo refinadas: `apps/scraper/src/extractors/notifications.ts` + tests.
15. Extraccion de curso refinada: `apps/scraper/src/extractors/notifications.ts` + tests.
16. Resolucion via folder API + dedupe: `apps/scraper/src/extractors/notifications.ts`.
17. Fallback HTML robusto: `apps/scraper/src/extractors/notifications.ts`.
18. Inferencia mime y saneamiento de nombre: `apps/scraper/src/extractors/notifications.ts`.
19. Pipeline secuencial por notificacion: `apps/scraper/src/extractors/notifications.ts`.
20. Dispatch timeout + logging contextual: `apps/scraper/src/extractors/notifications.ts`.
21. Delete TEC solo con `processed=true`: `apps/scraper/src/extractors/notifications.ts`.
22. Sin persistencia en procesamiento parcial: `apps/core/src/dispatcher.ts`.
23. Reintentos limpios tras fallo: `apps/core/src/dispatcher.ts`.
24. Download autenticado TEC->Drive mantenido a nivel de codigo, pero Drive no esta listo para uso operativo: `packages/drive/src/index.ts`.
25. Dedupe upload blindado por hash: `apps/core/src/dispatcher.ts` + `packages/database/src/queries.ts`.
26. Paridad Telegram mantenida por tipo/fallback: `packages/telegram/src/index.ts` + flujo dispatcher.
27. Consistencia en multi-archivo: `apps/core/src/dispatcher.ts`.
28. Logging estructurado estandarizado: `apps/scraper/src/logger.ts`, `apps/core/src/logger.ts`, `packages/drive/src/logger.ts`.
29. Metricas de ciclo agregadas: `apps/core/src/orchestrator.ts`.
30. Runbook de alertas definido: `docs/alerts-runbook.md`.
31. Plan de rollout/canary+rollback definido: `docs/rollout-plan.md`.
32. Limpieza final de componentes no API-only: `apps/scraper/Dockerfile`, `README.md`, `docs/status/PROJECT_STATUS.md`.

## Validaciones
- Build workspace: `pnpm -r build`.
- Tests clave: `pnpm --filter @tec-brain/scraper test`, `pnpm --filter @tec-brain/core test`.

## Nota operativa
La ejecucion de canary 10/50/100 y observacion de 7 dias requiere entorno productivo; el runbook y plan quedaron listos para ejecucion del flujo base. Drive no esta listo, asi que cualquier validacion productiva debe asumir fallback por Telegram para documentos.
