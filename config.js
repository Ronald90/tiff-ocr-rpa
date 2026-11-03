import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const config = {
    // OpenAI
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || '',
    idModel: process.env.OPENAI_ID_MODEL || '',
    textModel: process.env.OPENAI_TEXT_MODEL || '',
    ocrImageDetail: process.env.OCR_IMAGE_DETAIL || '',
    idImageDetail: process.env.ID_IMAGE_DETAIL || '',
    blankPageMedianPx: Number(process.env.BLANK_PAGE_MEDIAN_PX),
    blankPageDarkThreshold: Number(process.env.BLANK_PAGE_DARK_THRESHOLD),
    ocrReasoningEffort: process.env.OCR_REASONING_EFFORT || '',
    idReasoningEffort: process.env.ID_REASONING_EFFORT || '',
    textReasoningEffort: process.env.TEXT_REASONING_EFFORT || '',
    ocrMaxOutputTokens: parseInt(process.env.OCR_MAX_OUTPUT_TOKENS, 10),
    idMaxOutputTokens: parseInt(process.env.ID_MAX_OUTPUT_TOKENS, 10),
    openaiMaxInFlight: parseInt(process.env.OPENAI_MAX_IN_FLIGHT, 10),

    // Rendimiento
    concurrency: parseInt(process.env.CONCURRENCY, 10) || 2,
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 5,
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS, 10) || 10000,
    maxImageWidth: parseInt(process.env.MAX_IMAGE_WIDTH, 10) || 2048,
    maxImagePatches: parseInt(process.env.MAX_IMAGE_PATCHES, 10),
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500,
    timeoutPerPageMs: parseInt(process.env.TIMEOUT_PER_PAGE_MS, 10) || 180000,
    adjuntoChunkChars: process.env.ADJUNTO_CHUNK_CHARS
        ? parseInt(process.env.ADJUNTO_CHUNK_CHARS, 10)
        : 24000,

    // Carpetas
    inputDir: path.resolve(process.env.INPUT_DIR || './input'),
    outputDir: path.resolve(process.env.OUTPUT_DIR || './output'),
    processedDir: path.resolve(process.env.PROCESSED_DIR || './processed'),
    errorDir: path.resolve(process.env.ERROR_DIR || './error'),
    // Vacío desactiva la reutilización. Se configura explícitamente en .env.
    ocrCacheDir: process.env.OCR_CACHE_DIR ? path.resolve(process.env.OCR_CACHE_DIR) : '',
    // Vacío desactiva las confirmaciones manuales; definirlo en .env para usarlas.
    manualCodeConfirmationsFile: process.env.MANUAL_CODE_CONFIRMATIONS_FILE
        ? path.resolve(process.env.MANUAL_CODE_CONFIRMATIONS_FILE) : '',

    // Watcher
    watchIntervalMs: parseInt(process.env.WATCH_INTERVAL_MS, 10) || 5000,

    // Watcher batch
    maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE, 10) || 50,

    // Procesamiento paralelo de archivos
    fileConcurrency: parseInt(process.env.FILE_CONCURRENCY, 10) || 3,
};

// Validaciones
if (!config.apiKey) {
    console.error('Error: OPENAI_API_KEY no está configurada en .env');
    process.exit(1);
}

if (!config.model) {
    console.error('Error: OPENAI_MODEL no está configurado en .env');
    process.exit(1);
}

for (const [key, value] of [
    ['OPENAI_ID_MODEL', config.idModel],
    ['OPENAI_TEXT_MODEL', config.textModel],
    ['OCR_REASONING_EFFORT', config.ocrReasoningEffort],
    ['ID_REASONING_EFFORT', config.idReasoningEffort],
    ['TEXT_REASONING_EFFORT', config.textReasoningEffort]
]) {
    if (!value) throw new Error(`${key} no está configurado en .env`);
}

for (const [key, value] of [
    ['OCR_IMAGE_DETAIL', config.ocrImageDetail],
    ['ID_IMAGE_DETAIL', config.idImageDetail]
]) {
    if (!['high', 'original'].includes(value)) throw new Error(`${key} debe ser high u original`);
}

for (const [key, value] of [
    ['OCR_MAX_OUTPUT_TOKENS', config.ocrMaxOutputTokens],
    ['ID_MAX_OUTPUT_TOKENS', config.idMaxOutputTokens],
    ['MAX_IMAGE_PATCHES', config.maxImagePatches],
    ['OPENAI_MAX_IN_FLIGHT', config.openaiMaxInFlight]
]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} debe ser un entero positivo`);
}

if (!Number.isInteger(config.blankPageMedianPx) || config.blankPageMedianPx < 3 || config.blankPageMedianPx % 2 !== 1) {
    throw new Error('BLANK_PAGE_MEDIAN_PX debe ser un entero impar de al menos 3');
}
if (!Number.isInteger(config.blankPageDarkThreshold) || config.blankPageDarkThreshold < 1 || config.blankPageDarkThreshold > 255) {
    throw new Error('BLANK_PAGE_DARK_THRESHOLD debe ser un entero entre 1 y 255');
}

if (!Number.isInteger(config.adjuntoChunkChars) || config.adjuntoChunkChars < 1000) {
    throw new Error('ADJUNTO_CHUNK_CHARS debe ser un entero de al menos 1000');
}

export default config;
