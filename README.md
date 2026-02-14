# TIFF OCR RPA

Sistema RPA para procesar archivos TIFF multipágina mediante OCR con GPT-4o Vision y extracción automática de datos estructurados en JSON.

## Requisitos

- Node.js 18+
- API key de OpenAI con acceso a GPT-4o

## Instalación

```bash
npm install
cp .env.example .env
# Editar .env con tu OPENAI_API_KEY
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
├── logger.js           Logger con rotación y buffer
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
| `tipo_documento` | string | Tipo de documento (Circular, Carta Circular, Nota, etc.) |
| `numero_documento` | string | Código identificador del documento |
| `departamento` | string | Departamento de Bolivia |
| `fecha` | string | Fecha en formato YYYY-MM-DD |
| `destinatario` | string | A quién va dirigido |
| `referencia` | string | Asunto o referencia (REF:) |
| `para_conocimiento` | array | Entidades para conocimiento y cumplimiento |
| `documentos_adjuntos` | array | Documentos adjuntos listados |

## Configuración (.env)

| Variable | Default | Descripción |
|---|---|---|
| `OPENAI_API_KEY` | — | API key de OpenAI (requerida) |
| `OPENAI_MODEL` | `gpt-4o` | Modelo a usar |
| `CONCURRENCY` | `3` | Páginas procesadas en paralelo |
| `MAX_RETRIES` | `3` | Reintentos por página |
| `MAX_FILE_SIZE_MB` | `200` | Tamaño máximo de archivo |
| `TIMEOUT_PER_PAGE_MS` | `120000` | Timeout por página (2 min) |
| `WATCH_INTERVAL_MS` | `5000` | Intervalo de polling del watcher |
