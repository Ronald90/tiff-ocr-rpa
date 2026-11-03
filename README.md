# TIFF Vision RPA

Sistema RPA para procesar archivos TIFF multipágina mediante Vision con el modelo configurado en `.env` y extracción automática de datos estructurados en JSON.

Configuración de la plantilla: `gpt-6-astra` transcribe las imágenes y `gpt-6.1-terra` identifica los códigos y extrae los campos JSON. La transcripción usa `detail: "original"` para conservar el texto pequeño. Cada etapa se puede configurar por separado en `.env`.

Cada página se transcribe una sola vez. El código R- de cada adjunto se busca primero en ese texto (sello con prefijo R o dígitos exactos junto al sello ASFI); solo cuando el texto no lo muestra con claridad se consulta la imagen. Cada adjunto incluye todas las páginas siguientes sin código propio, sin tope; una página en blanco se salta sin cerrar el adjunto. Al ubicar todos los códigos se dejan de leer páginas, salvo las continuaciones del último adjunto. Cada código ubicado se contrasta después con una segunda lectura de la imagen. Si difiere, se hace una lectura adicional con el otro modelo; si tampoco confirma el código, el TIFF requiere revisión.

## Requisitos

- Node.js 18+
- API key de OpenAI con acceso a los modelos configurados en `.env`

## Instalación

```bash
npm install
# Crear/editar .env con OPENAI_API_KEY y los modelos
```

## Uso

### Modo CLI (un archivo)

```bash
node main.js <archivo.tiff>
```

### Modo RPA (monitoreo automático)

```bash
npm run watch
```

Coloca archivos `.tif`/`.tiff` en la carpeta `input/`. El sistema los procesa automáticamente y genera:
- `output/<nombre>_vision.txt` — Texto de la carátula y de todas las páginas de los adjuntos ubicados, incluidas sus continuaciones
- `output/<nombre>_datos.json` — Datos estructurados extraídos

Los archivos procesados se mueven a `processed/` y los que fallan a `error/`.
En modo RPA, `output/` contiene solo los TXT y JSON de TIFF aceptados. Si un
TIFF termina con errores, `error/` conserva solo el original, sin TXT ni JSON.
Si configuras `OCR_CACHE_DIR`, las respuestas válidas de la API se conservan en
esa carpeta como archivos binarios comprimidos. Al volver a intentar el mismo
TIFF se reutilizan las solicitudes idénticas, incluso si el TIFF anterior fue
rechazado. Cambiar el modelo, el prompt, sus parámetros o la imagen crea otra
solicitud y no reutiliza la respuesta vieja. Las lecturas visuales de
verificación siempre se repiten para permitir resolver discrepancias. La
primera ejecución después de activar la caché todavía debe consultar la API.
La carpeta de caché contiene datos del documento; se puede borrar manualmente
cuando ya no se necesite, y no se publica en `output/`.
El log `[API-USAGE]` informa por TIFF las llamadas nuevas, las reutilizadas y
los tokens de entrada y salida que devolvió la API. No calcula dinero porque
los precios dependen de cada modelo y cuenta.
Los adjuntos largos se dividen en fragmentos sin descartar texto. La carátula
también se envía completa. Los campos del documento R se extraen de su página
principal; las páginas adicionales aportan demandados, juez, juzgado,
NUREJ/CUD y montos retenidos cuando pertenecen al mismo proceso, pero no
reemplazan el cite, la fecha ni el demandante del principal. Los campos vacíos
se dejan vacíos cuando solo figuran en un documento de otro proceso.
Si falla la extracción de alguna parte, el TIFF se envía a `error/` y no se
publican TXT ni JSON. Un monto o un demandado que difieren de verdad entre
páginas también envían el TIFF a `error/`; los montos se comparan por su valor
(`1.000,00`, `1000` y `Bs. 1.000.-` son iguales) y la misma persona con otra
resolución es otra fila. Una fila sin resolución solo se une si su monto la
vincula de forma única; si sigue siendo ambigua, el TIFF va a `error/`.
Las variantes claras de título profesional u ordinal de juez o juzgado se
conservan con una advertencia. Una persona o juzgado realmente distinto
envía el TIFF a `error/` para revisión.
Una respuesta OCR vacía se repite una vez. Solo se acepta como página en blanco
si no queda ningún píxel oscuro después de quitar motas con la mediana
configurada. Si queda tinta y el segundo OCR sigue vacío, el TIFF va a `error/`.
Un encabezado de CITE, oficio o carta
circular con identificador distinto dentro de una supuesta continuación se
marca para revisión. Un título aislado de oficio o carta circular al inicio de
la página, sin identificador legible, también requiere revisión. Las menciones
de resoluciones dentro de un adjunto siguen como páginas de respaldo.

El JSON aceptado incluye `estado_procesamiento: "completo"`. Los estados
`"requiere_revision"` (por ejemplo, un código R que no coincide en la segunda
lectura) y `"error"` (por ejemplo, un código faltante o una extracción fallida)
solo se usan internamente para decidir el destino del TIFF. Una segunda lectura
automática reduce errores, pero no garantiza reconocimiento del 100 %; para esa
exigencia hace falta comparar con el original y revisar los casos dudosos.

En un TIFF SIREFO de una sola página, una referencia a instrucciones adjuntas
sin código R se conserva en `documentos_adjuntos` y se avisa en `advertencias`;
no se marca como código faltante porque ese detalle no está dentro del TIFF.
Un código R mencionado y no localizado sigue siendo un error.

## Estructura del proyecto

```
├── .env.example        Plantilla de configuración
├── config.js           Configuración centralizada
├── openai-client.js    Cliente OpenAI compartido
├── proxy.js            Proxy corporativo (undici)
├── logger.js           Logger async con rotación y stream
├── ocr-engine.js       Motor Vision (extracción de páginas + reintentos)
├── extractor.js        Extracción JSON con IA
├── main.js             CLI
├── watcher.js          Monitor de carpeta (RPA)
├── input/              Archivos TIFF a procesar
├── output/             Resultados (TXT + JSON)
├── processed/          TIFFs procesados
└── error/              TIFFs con error
```

## Campos extraídos (JSON)

| Campo | Tipo | Descripción |
|---|---|---|
| `tipo_documento` | string | Clasificación del documento (Circular, Carta Circular, Nota, etc.) |
| `documento` | string | Línea identificadora completa del documento |
| `denominacion` | string | Título o denominación visible del cuerpo del documento |
| `ciudad` | string | Ciudad de emisión |
| `departamento` | string | Departamento de Bolivia |
| `fecha` | string | Fecha en formato YYYY-MM-DD |
| `destinatario` | string | A quién va dirigido |
| `referencia` | string | Asunto o referencia (REF:) |
| `numero_tramite` | string | Número de trámite (ej: T-1211407819) |
| `es_sirefo` | boolean | Indica si la carátula menciona SIREFO/SIREFI o el sistema de retención/remisión de fondos |
| `para_conocimiento` | array | Entidades para conocimiento y cumplimiento |
| `documentos_adjuntos` | array | Documentos adjuntos listados |
| `modificaciones` | array | Menciones de modificaciones normativas |
| `estado_procesamiento` | string | `completo`, `requiere_revision` o `error`; solo `completo` se publica en `output/` en modo RPA |
| `ubicacion_adjuntos[].codigo_verificado` | boolean | Indica si una lectura visual de verificación confirmó dígito por dígito el código R esperado |

## Configuración (.env)

| Variable | Default | Descripción |
|---|---|---|
| `OPENAI_API_KEY` | — | API key de OpenAI (requerida) |
| `OPENAI_MODEL` | — | Modelo que transcribe páginas y recupera el juez (requerido) |
| `OPENAI_ID_MODEL` | — | Modelo que identifica códigos de adjuntos (requerido) |
| `OPENAI_TEXT_MODEL` | — | Modelo que convierte el texto OCR a JSON (requerido) |
| `OCR_IMAGE_DETAIL` | — | Detalle de imagen de transcripción: `original` o `high` |
| `ID_IMAGE_DETAIL` | — | Detalle de imagen de identificación: `original` o `high` |
| `BLANK_PAGE_MEDIAN_PX` | — | Ventana impar del filtro de mediana para evaluar páginas con OCR vacío; la configuración local usa `3` |
| `BLANK_PAGE_DARK_THRESHOLD` | — | Umbral de gris para considerar tinta un píxel; la configuración local usa `128` |
| `OCR_REASONING_EFFORT` | — | Esfuerzo de razonamiento para OCR y recuperación de juez |
| `ID_REASONING_EFFORT` | — | Esfuerzo de razonamiento para identificación |
| `TEXT_REASONING_EFFORT` | — | Esfuerzo de razonamiento para extracción JSON |
| `OCR_MAX_OUTPUT_TOKENS` | — | Tope de salida de la transcripción; una salida truncada se reintenta una vez con el doble de tokens |
| `ID_MAX_OUTPUT_TOKENS` | — | Tope de salida para identificar códigos o juez |
| `OPENAI_MAX_IN_FLIGHT` | — | Máximo global de llamadas simultáneas a OpenAI entre todos los archivos |
| `OCR_CACHE_DIR` | vacío (desactivada) | Carpeta de caché privada de respuestas válidas; la plantilla usa `./.ocr-cache` |
| `CONCURRENCY` | `2` | Páginas leídas y adjuntos extraídos en paralelo por archivo; los códigos se asignan en el orden del TIFF |
| `FILE_CONCURRENCY` | `3` | Archivos procesados en paralelo |
| `MAX_RETRIES` | `5` | Intentos por llamada ante errores transitorios (red, timeout, 429, 5xx); un 400/401/403/404/422 no se reintenta |
| `MAX_IMAGE_WIDTH` | `2048` | Ancho máximo real de cada página enviada al modelo; la plantilla usa `6000` |
| `MAX_IMAGE_PATCHES` | — | Límite de parches de 32 px para evitar rechazos con `detail: original`; la plantilla usa `28000` |
| `ADJUNTO_CHUNK_CHARS` | `24000` | Tamaño aproximado de cada fragmento de texto de un adjunto largo; no se descarta texto |
| `MAX_FILE_SIZE_MB` | `500` | Tamaño máximo de archivo |
| `TIMEOUT_PER_PAGE_MS` | `180000` | Timeout por página (3 min) |
| `WATCH_INTERVAL_MS` | `5000` | Intervalo de polling del watcher |
| `MAX_BATCH_SIZE` | `50` | Archivos máximos por ciclo del watcher |
| `LOG_DEBUG` | `false` | Habilitar logs de nivel DEBUG |
| `HTTPS_PROXY` | — | URL del proxy corporativo (HTTPS) |
| `HTTP_PROXY` | — | URL del proxy corporativo (HTTP) |

## Proxy Corporativo

Si estás en una red corporativa con proxy, configura las variables de entorno:

```bash
# En .env o como variable de entorno del sistema
HTTPS_PROXY=http://proxy.empresa.com:8080
HTTP_PROXY=http://proxy.empresa.com:8080
```

El sistema detecta automáticamente estas variables al iniciar y enruta todo el tráfico a OpenAI a través del proxy usando `undici ProxyAgent`.

Al iniciar verás en la consola:
```
[PROXY] Proxy corporativo detectado: http://proxy.empresa.com:8080
```

Si no hay proxy configurado, el sistema funciona con conexión directa sin cambios.
