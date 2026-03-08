Resumen de Inventario de Herramientas y Comportamiento (resp. rápido)

- **Qué contiene**: `docs/tools_inventory.json` con lista de herramientas, esquemas de entrada JSON y notas.

Respuestas rápidas a tus preguntas:

1) Inventario de métodos soportados
- Principales herramientas implementadas en el host: `navigate_to`, `scroll_page`, `get_dom_extra_elements`, `click_element`, `type_value`, `manage_tabs`.
- Extras/acciones definidas en el esquema de navegación (packages/schema-utils) incluyen: click_element (index/xpath), input_text, scroll_up/scroll_down, send_keys, open_tab/switch_tab/close_tab, etc.

2) Esquemas JSON exactos
- Cada herramienta tiene su `GetInputSchema()` en `mcp-host-go/pkg/tools/*.go` y están volcados en `tools_inventory.json`.
- Observación: la arquitectura prefiere `element_index` (0-based highlightIndex) como selector primario; algunas acciones aceptan `xpath` y el código de la extensión puede generar selectores CSS mejorados.

3) Formato de extracción / Read Mode
- `browser://dom/state` devuelve `text/markdown` (AI-friendly) con overview (hasta 20 elementos) y un bloque ```html``` con DOM simplificado.
- La extensión provee `parserReadability()` / `getReadabilityContent()` para modo lectura (extracto limpio, título, texto, excerpt).

4) Estado y sesiones
- Cookies/localStorage son gestionados por el contexto del navegador (Chrome extension). Si la IA interactúa en la misma pestaña, la sesión persiste mientras esa pestaña/instancia siga viva.
- Soporta múltiples pestañas; usar `tab_id` en argumentos o `manage_tabs` para abrir/switch/close.

5) Selectores y "smart" logic
- La extensión construye un árbol DOM y asigna `highlightIndex` a elementos interactivos; la herramienta usa esos índices.
- `DOMElementNode` tiene métodos para generar `getEnhancedCssSelector()` y convertir XPath a CSS simplificado. También hay utilidades para búsqueda por texto.

6) Límites, timeouts y errores
- Overview limita a 20 elementos; `get_dom_extra_elements` permite paginación (pageSize hasta 100).
- Timeouts: `navigate_to` 'auto' = 30000ms; `click_element` RPC timeout ~15000ms; `type_value` admite timeouts mayores (validación hasta 600000ms). RPC calls aplican buffers adicionales.
- Errores frecuentes: `ELEMENT_NOT_CLICKABLE`, `CLICK_FAILED`, `TYPE_VALUE_FAILED`, `RPC_ERROR`, y mensajes de "DOM state not available".

Siguientes pasos (opciones):
- Genero una versión compacta del JSON con sólo las rutas y esquemas para importarlo en n8n.
- Creo plantillas de nodos n8n con las entradas tipadas según estos esquemas.

Dime cuál opción prefieres y la implemento.