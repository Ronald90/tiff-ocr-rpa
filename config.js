import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const config = {
    // OpenAI
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',

    // Rendimiento
    concurrency: parseInt(process.env.CONCURRENCY) || 3,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 5000,
    maxImageWidth: parseInt(process.env.MAX_IMAGE_WIDTH) || 2048,
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB) || 200,
    timeoutPerPageMs: parseInt(process.env.TIMEOUT_PER_PAGE_MS) || 120000,

    // Carpetas
    inputDir: path.resolve(process.env.INPUT_DIR || './input'),
    outputDir: path.resolve(process.env.OUTPUT_DIR || './output'),
    processedDir: path.resolve(process.env.PROCESSED_DIR || './processed'),
    errorDir: path.resolve(process.env.ERROR_DIR || './error'),

    // Watcher
    watchIntervalMs: parseInt(process.env.WATCH_INTERVAL_MS) || 5000,
};

// Validaciones
if (!config.apiKey) {
    console.error('Error: OPENAI_API_KEY no está configurada en .env');
    process.exit(1);
}

export default config;
