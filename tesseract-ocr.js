import { createWorker } from 'tesseract.js';
import logger from './logger.js';

// ── Worker Pool reutilizable ──────────────────────────────────────────
// En lugar de crear un nuevo worker por cada llamada a recognize(),
// mantenemos un pool de workers persistentes que se reutilizan.

const POOL_SIZE = 2;

/** @type {import('tesseract.js').Worker[]} */
let workers = [];
let currentWorkerIndex = 0;
let initialized = false;
let initializing = null;

/**
 * Inicializa el pool de workers de Tesseract.
 * Se llama automáticamente la primera vez que se usa ocrWithTesseract.
 * @returns {Promise<void>}
 */
async function initPool() {
    if (initialized) return;
    if (initializing) return initializing;

    initializing = (async () => {
        logger.debug(`[TESSERACT] Inicializando pool de ${POOL_SIZE} workers...`);
        const createPromises = [];
        for (let i = 0; i < POOL_SIZE; i++) {
            createPromises.push(
                createWorker('spa', 1, {
                    logger: () => { } // Silenciar logs internos de Tesseract
                })
            );
        }
        workers = await Promise.all(createPromises);
        initialized = true;
        initializing = null;
        logger.debug(`[TESSERACT] Pool de ${POOL_SIZE} workers listo.`);
    })();

    return initializing;
}

/**
 * Obtiene el siguiente worker del pool usando round-robin.
 * @returns {import('tesseract.js').Worker}
 */
function getWorker() {
    const worker = workers[currentWorkerIndex];
    currentWorkerIndex = (currentWorkerIndex + 1) % workers.length;
    return worker;
}

/**
 * OCR de una imagen usando Tesseract.js con worker pool reutilizable.
 * Ideal para texto impreso claro como listas numeradas de códigos.
 * @param {Buffer} pngBuffer — Buffer de la imagen PNG
 * @param {number} pageNum — Número de página (para logging)
 * @returns {Promise<string>} — Texto extraído
 */
export async function ocrWithTesseract(pngBuffer, pageNum) {
    try {
        await initPool();

        const worker = getWorker();
        const { data: { text } } = await worker.recognize(pngBuffer);

        if (!text || text.trim().length === 0) {
            logger.warn(`[TESSERACT] Página ${pageNum}: No se extrajo texto`);
            return '';
        }

        return text.trim();
    } catch (err) {
        logger.error(`[TESSERACT] Error en página ${pageNum}: ${err.message}`);
        throw err;
    }
}

/**
 * Termina todos los workers del pool. Llamar al cierre de la aplicación.
 * @returns {Promise<void>}
 */
export async function terminateTesseractPool() {
    if (!initialized || workers.length === 0) return;
    logger.debug('[TESSERACT] Terminando pool de workers...');
    await Promise.all(workers.map(w => w.terminate()));
    workers = [];
    initialized = false;
    currentWorkerIndex = 0;
}
