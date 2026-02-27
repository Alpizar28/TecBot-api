# Rollout Plan (Canary -> 100%)

## Estrategia de despliegue
- Despliegue directo API-only.
- Rollback por release/tag anterior estable.

## Etapas
1. Canary 10% usuarios activos por 48h.
2. Escalado a 50% por 72h.
3. Escalado a 100% por 7 dias.

## Gate por etapa
- Build/test en verde.
- Sin aumento significativo de `notifications_partial`.
- Sin perdida de eventos (no borrado TEC con `processed=false`).
- Tasa de upload estable.

## Rollback
- Volver al release/tag anterior.
- Reiniciar servicios.
- Mantener logs para RCA.
