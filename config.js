import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const config = {
    // OpenAI
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',

    // Rendimiento
    concurrency: parseInt(process.env.CONCURRENCY, 10) || 2,
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 5,
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS, 10) || 10000,
    maxImageWidth: parseInt(process.env.MAX_IMAGE_WIDTH, 10) || 2048,
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500,
    timeoutPerPageMs: parseInt(process.env.TIMEOUT_PER_PAGE_MS, 10) || 180000,

    // Carpetas
    inputDir: path.resolve(process.env.INPUT_DIR || './input'),
    outputDir: path.resolve(process.env.OUTPUT_DIR || './output'),
    processedDir: path.resolve(process.env.PROCESSED_DIR || './processed'),
    errorDir: path.resolve(process.env.ERROR_DIR || './error'),

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

export default config;
