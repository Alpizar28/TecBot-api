# Baseline Metrics (Referencia Inicial)

Fecha de baseline: 2026-02-27

## KPI minimos
- `cycle_duration_ms`
- `notifications_fetched`
- `notifications_processed`
- `notifications_partial`
- `documents_resolved`
- `uploads_ok`
- `uploads_failed`
- `deleted_in_tec`

## Meta operativa para API-only
- Mantener consumo RAM bajo y estable en produccion.
- Mantener o mejorar tasa de `documents_resolved`.
- Mantener `deleted_in_tec` alineado 1:1 con `processed=true`.

## Registro
Completar semanalmente durante rollout:
- Semana
- Usuarios canary
- Error rate
- Resolucion documentos
- Decisiones y acciones
