# Parity Matrix: Playwright Legacy vs API-Only

| Scenario | Legacy (Playwright) | API-Only Target | Current Status |
|---|---|---|---|
| Noticia | Detecta y envia Telegram | Igual, sin navegador | Done |
| Evaluacion | Detecta por texto UI | Detecta por heuristica API | Done |
| Documento (1 archivo) | Resuelve y sube a Drive | Resuelve via folder API/fallback y sube | Done |
| Documento (multiples) | Itera archivos en UI | Itera lista API/fallback y deduplica | Done |
| Documento no resoluble | Envia fallback con link | Igual | Done |
| Deduplicacion notificacion | DB por `external_id` | Igual | Done |
| Deduplicacion archivo | Hash por URL+nombre | Igual | Done |
| Borrado en TEC | Al confirmar flujo | Solo con `processed=true` | Done |
| Sesion expirada | Relogin browser | Relogin JSON + verificacion endpoint | Done |

## Nota
El flujo API-only depende de endpoints internos de TEC Digital; por eso se mantiene fallback, logging estructurado y reglas de rollback operacional.
