# Acceptance Criteria: API-Only

## C1 - Noticia
- Input: notificacion tipo noticia sin archivos.
- Expected: mensaje Telegram de noticia enviado una vez.
- DB: notificacion insertada.
- TEC delete: si y solo si `processed=true`.

## C2 - Evaluacion
- Input: notificacion con keyword evaluacion/tarea/examen.
- Expected: mensaje Telegram de evaluacion.
- DB: notificacion insertada.
- TEC delete: condicionado por `processed=true`.

## C3 - Documento simple
- Input: notificacion documento con archivo resoluble.
- Expected: descarga autenticada + intento de upload Drive + fallback por Telegram mientras Drive siga caido.
- DB: notificacion insertada; `uploaded_files` solo si el upload realmente fue exitoso.
- TEC delete: solo con `processed=true`.

## C4 - Documento multiple
- Input: notificacion documento con N archivos.
- Expected: todos los archivos deduplicados y procesados, con fallback si Drive falla.
- DB: registros de upload solo para los archivos que si logren subirse.
- TEC delete: solo si todos los pasos requeridos fueron exitosos.

## C5 - Documento no resoluble
- Input: documento sin links/ids resolubles.
- Expected: fallback Telegram con link original.
- DB: notificacion no debe marcarse como procesada si hubo fallo parcial.
- TEC delete: no borrar con `processed=false`.

## C6 - Sesion
- Input: cookies expiradas o session file corrupto.
- Expected: relogin JSON automatico o cuarentena de archivo corrupto.
- Resultado: ciclo continua sin intervencion manual.
