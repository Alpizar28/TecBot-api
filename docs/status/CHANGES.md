# CHANGES

Historial activo del proyecto API-only.

## 2026-02-27
- Flujo de notificaciones 100% por APIs internas de TEC Digital.
- Logging estructurado en scraper/core/drive.
- Sesiones robustas con validacion, reintentos y cuarentena de session JSON corrupto.
- Heuristicas refinadas de tipo/curso/archivos.
- Validacion estricta para eliminar notificaciones en TEC solo con `processed=true`.
- Tests de heuristicas y dispatcher agregados.
