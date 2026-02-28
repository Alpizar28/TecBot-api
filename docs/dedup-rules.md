# Reglas de Deduplicacion

## Notificaciones
- Clave: `user_id + external_id`.
- Tabla: `notifications`.
- Efecto: evita reenviar una notificacion ya procesada.

## Archivos
- Clave: `user_id + file_hash`.
- Hash: `sha256(download_url + file_name)`.
- Tabla: `uploaded_files`.
- Efecto: evita reintentos duplicados cuando Drive este listo; hoy no debe asumirse upload funcional.

## Reintentos
- Si procesamiento es parcial/fallido: no persistir como completado.
- Si `processed=false`: no borrar en TEC.
- Resultado: la notificacion sigue disponible para siguiente ciclo.
