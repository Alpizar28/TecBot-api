# Parity Matrix: Flujo Actual API-Only

| Scenario | Flujo actual | Resultado esperado | Status |
|---|---|---|---|
| Noticia | Detecta y envia Telegram | Igual, sin navegador | Done |
| Evaluacion | Detecta por heuristica API | Detecta por heuristica API | Done |
| Documento (1 archivo) | Resuelve y sube a Drive | Resuelve via folder API/fallback y sube | Done |
| Documento (multiples) | Itera lista API/fallback y deduplica | Itera lista API/fallback y deduplica | Done |
| Documento no resoluble | Envia fallback con link | Igual | Done |
| Deduplicacion notificacion | DB por `external_id` | Igual | Done |
| Deduplicacion archivo | Hash por URL+nombre | Igual | Done |
| Borrado en TEC | Al confirmar flujo | Solo con `processed=true` | Done |
| Sesion expirada | Relogin JSON + verificacion endpoint | Relogin JSON + verificacion endpoint | Done |

## Nota
El flujo API-only depende de endpoints internos de TEC Digital; por eso se mantiene fallback, logging estructurado y reglas de rollback operacional.
