# Plan API-Only (Pendiente)

Este plan fue depurado para dejar **solo lo que falta**.
Lo implementado al 100% en repositorio ya no se lista aqui.

Referencia de cierre tecnico (32/32 en codigo/docs):
- `docs/api-only-progress.md`

## Estado actual
- Implementacion API-only: completa en codigo.
- Build/tests locales: en verde.
- Pendiente real: validacion operativa en entorno productivo (canary + observacion).

## Pendientes unicos

### P1. Canary 10%
- Accion: desplegar version API-only para 10% de usuarios activos.
- Duracion sugerida: 48h.
- Exito:
  - Sin aumento relevante de `notifications_partial`.
  - Sin borrados en TEC con `processed=false`.
  - Tasa de upload estable.

### P2. Escalado 50%
- Accion: ampliar canary al 50%.
- Duracion sugerida: 72h.
- Exito:
  - KPI estables respecto canary 10%.
  - Sin incidentes de sesion/login recurrentes.

### P3. Escalado 100%
- Accion: ejecutar API-only para el 100% de usuarios.
- Duracion sugerida: 7 dias de observacion.
- Exito:
  - Operacion estable continua.
  - Sin regresion funcional en Telegram. Drive no esta listo y no debe usarse como criterio de salida estable.

### P4. Cierre operativo
- Accion: emitir acta de cierre con metricas finales y lecciones.
- Entregable: actualizar `docs/api-only-progress.md` con evidencia de produccion.
- Exito: decision Go-Live definitiva firmada.

## Rollback (si aplica)
- Volver al release/tag anterior estable.
- Reiniciar servicios y documentar RCA.

## Criterio final de completitud
- Canary 10%/50%/100% completado sin regresiones criticas.
- 7 dias estables en 100% API-only.
- Cierre operativo documentado.
