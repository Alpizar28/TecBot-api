# CHANGES - TEC Digital Migration (Playwright to HTTP API)

Este documento detalla la transformación técnica del sistema de scraping para optimizar el rendimiento y la escalabilidad en entornos con recursos limitados (AWS 2GB RAM).

---

## 🎯 Objetivo General
Eliminar la dependencia de **Playwright/Chromium** en el servicio de scraping. El objetivo es reducir el consumo de RAM de ~800MB a <100MB por instancia de usuario, permitiendo el despliegue en servidores pequeños sin caídas por falta de memoria.

---

## 📈 Resumen del Progreso

| Fase | Tarea | Estado |
| :--- | :--- | :--- |
| **1. Análisis** | Ingeniería inversa de red del portal TEC Digital | ✅ **Completado** |
| **2. Core HTTP** | Desarrollo de `TecHttpClient` (Axios + Cookies) | ✅ **Completado** |
| **3. Migración** | Refactorización de SessionManager y Extradores | ✅ **Completado** |
| **4. Optimización** | Bypass de rutas Angular (File Storage API) | ✅ **Completado** |
| **5. Cleanup** | Uninstal de Playwright y borrado de lógica DOM | ✅ **Completado** |
| **6. Verificación** | Pruebas end-to-end con credenciales reales | 🔄 **En Progreso** |

---

## 🛠️ Cambios Técnicos Principales

### 1. Eliminación de Playwright
- Se desinstalaron `playwright`, `@playwright/test` y plugins asociados.
- El servidor ya no levanta procesos de navegador en segundo plano.

### 2. Nuevo Cliente: `TecHttpClient`
- **Axios con Soporte de Cookies:** Implementación de `axios-cookiejar-support` y `tough-cookie` para mantener la sesión viva entre peticiones.
- **Login Directo:** El proceso de autenticación ahora toma ~1s mediante un POST JSON directo al API de login del TEC.
- **Bypass de Sesión:** Agregado GET a `/dotlrn/` para instanciar automáticamente el `JSESSIONID` de Tomcat.

### 3. Extracción vía API Interna
- En lugar de parsear el DOM (HTML), consultamos los endpoints AJAX del TEC:
  - `get_user_notifications`: Devuelve JSON con las notificaciones.
  - `folder-chunk`: Devuelve la lista de archivos de una carpeta directamente en JSON, saltándose las rutas de Angular `#/...`.
  - `notification_delete`: Borrado instantáneo vía GET.

---

## 📊 Beneficios Alcanzados (Estimados)

- **Ahorro de Memoria:** Reducción de **-90%** en el uso de RAM (de ~600MB a ~50MB).
- **Velocidad de Procesamiento:** Mejora de **7x** (de ~15s a ~2s por ciclo de usuario).
- **Estabilidad:** Eliminación de errores de "Timeout" por carga lenta de Chromium.
- **Despliegue Simple:** Ya no se requiere configurar drivers de navegador ni librerías de sistema de Linux en AWS.

---

## 🚧 Próximos Pasos
1.  **Validación de Flujo Completo:** Verificar el envío real de notificaciones al `core` y su posterior borrado en el servidor del TEC.
2.  **Limpieza Final:** Eliminar logs de depuración interna.
3.  **Deployment:** Preparar la nueva imagen/configuración para AWS sin dependencias de navegador.

---
**Ultima Actualización:** 2026-02-26
**Estado:** Funcional en rama de desarrollo.
