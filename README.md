# TIFF OCR RPA

Sistema RPA para procesar archivos TIFF multipágina mediante OCR con el modelo configurado en `.env` y extracción automática de datos estructurados en JSON.

## Requisitos

- Node.js 18+
- API key de OpenAI con acceso al modelo configurado en `OPENAI_MODEL`

## Instalación

```bash
npm install
# Crear/editar .env con OPENAI_API_KEY y OPENAI_MODEL
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
- `output/<nombre>_ocr.txt` — Texto OCR completo
- `output/<nombre>_datos.json` — Datos estructurados extraídos

Los archivos procesados se mueven a `processed/` y los que fallan a `error/`.

## Estructura del proyecto

```
├── .env.example        Plantilla de configuración
├── config.js           Configuración centralizada
├── openai-client.js    Cliente OpenAI compartido
├── proxy.js            Proxy corporativo (undici)
├── logger.js           Logger async con rotación y stream
├── ocr-engine.js       Motor OCR (worker pool + reintentos)
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
| `ciudad` | string | Ciudad de emisión |
| `departamento` | string | Departamento de Bolivia |
| `fecha` | string | Fecha en formato YYYY-MM-DD |
| `destinatario` | string | A quién va dirigido |
| `referencia` | string | Asunto o referencia (REF:) |
| `numero_tramite` | string | Número de trámite (ej: T-1211407819) |
| `es_sirefo` | boolean | Indica si la carátula menciona SIREFO/SIREFI o el sistema de retención/remisión de fondos |
| `para_conocimiento` | array | Entidades para conocimiento y cumplimiento |
| `documentos_adjuntos` | array | Documentos adjuntos listados |

## Configuración (.env)

| Variable | Default | Descripción |
|---|---|---|
| `OPENAI_API_KEY` | — | API key de OpenAI (requerida) |
| `OPENAI_MODEL` | — | Modelo a usar (requerido) |
| `OPENAI_STRONG_MODEL` | igual a `OPENAI_MODEL` | Modelo fuerte opcional para reintentos críticos cuando la extracción o identificación falla |
| `CONCURRENCY` | `2` | Páginas procesadas en paralelo por archivo |
| `FILE_CONCURRENCY` | `3` | Archivos procesados en paralelo |
| `MAX_RETRIES` | `5` | Reintentos por página |
| `MAX_IMAGE_WIDTH` | `2048` | Ancho máximo de imagen en px (redimensionamiento) |
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
