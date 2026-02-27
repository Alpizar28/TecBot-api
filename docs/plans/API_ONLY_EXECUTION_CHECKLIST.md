# API-Only Checklist (Solo Pendientes)

Este checklist fue limpiado para mostrar solo trabajo pendiente.

## Completado
- Implementacion tecnica y documental del plan original: completada.
- Evidencia: `docs/api-only-progress.md`.

## Pendiente operativo
- [ ] P1: Ejecutar canary 10% (48h) y registrar metricas.
- [ ] P2: Escalar a 50% (72h) y registrar metricas.
- [ ] P3: Escalar a 100% y observar 7 dias.
- [ ] P4: Emitir cierre operativo final (Go-Live definitivo).

## Validaciones minimas por etapa
- [ ] `notifications_partial` dentro de umbral.
- [ ] `deleted_in_tec` alineado con `processed=true`.
- [ ] `uploads_failed` sin tendencia creciente.
- [ ] Sin incidentes criticos de login/sesion.

## Registro operativo
```md
Fecha:
Etapa (10/50/100):
Usuarios impactados:
KPI clave:
Incidentes:
Decision Go/No-Go:
Accion siguiente:
```
