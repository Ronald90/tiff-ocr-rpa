import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';
import { processFile } from './ocr-engine.js';
import { isInsufficientQuotaError } from './openai-errors.js';
import { isFileStable } from './utils.js';

// ── Estado del watcher ────────────────────────────────────────────────

const HISTORY_FILE = path.resolve('./.processed_history.jsonl');

/** Tamaño de la porción de archivo a hashear para identificación única (16 KB) */
const HASH_SAMPLE_SIZE = 16384;

/** Pausa antes de reintentar si OpenAI devuelve cuota insuficiente. */
const OPENAI_QUOTA_PAUSE_MS = 5 * 60 * 1000;

const historyMap = new Map();
/** Tamaño y fecha de cada TIFF de input/ en la revisión anterior */
const fileSignatures = new Map();
let historyStream = null;
let processing = false;
let openAIQuotaPauseUntil = 0;

/**
 * Cargar historial en memoria al inicio (reconstruir desde log NDJSON).
 */
function loadHistoryMap() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.key && entry.invalidated === true) {
                        historyMap.delete(entry.key);
                    } else if (entry.key && entry.data) {
                        historyMap.set(entry.key, entry.data);
                    }
                } catch { /* ignore corrupted lines */ }
            }
            logger.info(`[HIST] Historial cargado: ${historyMap.size} archivos procesados previos.`);
        }
    } catch (err) {
        logger.error(`Error cargando historial: ${err.message}`);
    }
}

/**
 * Inicializar stream de escritura (append-only).
 */
function initHistoryStream() {
    historyStream = fs.createWriteStream(HISTORY_FILE, { flags: 'a', encoding: 'utf8' });
    historyStream.on('error', (err) => {
        logger.error(`Error escribiendo historial: ${err.message}`);
    });
}

/**
 * Agregar al historial (Memoria + Disco).
 * @param {string} key - Clave única del archivo
 * @param {object} data - Datos del procesamiento
 */
function addToHistory(key, data) {
    historyMap.set(key, data);
    if (historyStream) {
        const line = JSON.stringify({ key, data });
        historyStream.write(line + '\n');
    }
}

/**
 * Verifica si un archivo tiene extensión TIFF.
 * @param {string} filename - Nombre del archivo
 * @returns {boolean}
 */
function isTiff(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.tif', '.tiff'].includes(ext);
}

// ── Mover archivo ─────────────────────────────────────────────────────

/**
 * Mueve un archivo a un directorio destino. Si ya existe, agrega timestamp.
 * Valida que el origen no sea un symlink para prevenir manipulación.
 * @param {string} src - Ruta origen
 * @param {string} destDir - Directorio destino
 * @returns {string} - Ruta final del archivo movido
 */
function moveFile(src, destDir) {
    // Validar que no sea un symlink (prevención de manipulación)
    const srcStat = fs.lstatSync(src);
    if (srcStat.isSymbolicLink()) {
        logger.warn(`[MOVE] Ignorando symlink: ${src}`);
        return src;
    }

    const destPath = path.join(destDir, path.basename(src));

    // Si ya existe en destino, agregar timestamp
    if (fs.existsSync(destPath)) {
        const ext = path.extname(destPath);
        const base = path.basename(destPath, ext);
        const ts = Date.now();
        const newPath = path.join(destDir, `${base}_${ts}${ext}`);
        fs.renameSync(src, newPath);
        return newPath;
    }

    fs.renameSync(src, destPath);
    return destPath;
}

// ── Procesar archivos pendientes ──────────────────────────────────────

/**
 * Escanea el directorio de entrada y procesa archivos TIFF pendientes
 * en paralelo usando un worker pool de tamaño configurable.
 */
async function processPendingFiles() {
    if (processing) return;
    if (Date.now() < openAIQuotaPauseUntil) return;
    processing = true;

    try {
        const allFiles = fs.readdirSync(config.inputDir).filter(isTiff);
        const present = new Set(allFiles.map(filename => path.join(config.inputDir, filename)));
        for (const filePath of fileSignatures.keys()) {
            if (!present.has(filePath)) fileSignatures.delete(filePath);
        }
        if (allFiles.length === 0) return;

        // Filtrar archivos YA procesados usando el Map en memoria
        const pending = [];

        for (const filename of allFiles) {
            // Si ya llenamos el batch, paramos de analizar
            if (pending.length >= config.maxBatchSize) break;

            const filePath = path.join(config.inputDir, filename);

            try {
                const stat = fs.statSync(filePath);

                // Un TIFF que todavia se esta copiando cambia de tamano o fecha
                // entre revisiones: se procesa cuando se mantiene igual.
                if (!isFileStable(fileSignatures, filePath, stat)) continue;

                // Hash SHA-256 parcial (16 KB) para identificación más robusta
                const buf = Buffer.alloc(HASH_SAMPLE_SIZE);
                const fd = fs.openSync(filePath, 'r');
                const bytesRead = fs.readSync(fd, buf, 0, HASH_SAMPLE_SIZE, 0);
                fs.closeSync(fd);

                const partialHash = crypto
                    .createHash('sha256')
                    .update(buf.subarray(0, bytesRead))
                    .digest('hex')
                    .substring(0, 16);

                const fileKey = `${filename}::${stat.size}::${partialHash}`;

                if (historyMap.has(fileKey)) {
                    const prev = historyMap.get(fileKey);
                    logger.warn(`Saltando ${filename} (ya procesado el ${prev.date})`);
                    try {
                        moveFile(filePath, config.processedDir);
                    } catch { /* ignore */ }
                    continue;
                }

                pending.push({ filename, filePath, fileKey });

            } catch (err) {
                logger.error(`Error analizando ${filename}: ${err.message}`);
            }
        }

        if (pending.length === 0) return;

        logger.info(`[PROCESS] Procesando lote de ${pending.length} archivo(s) (${config.fileConcurrency} workers)`);

        // Worker pool con índice atómico (seguro en single-thread de Node)
        let nextIndex = 0;
        let stopBatch = false;
        let quotaLogged = false;

        async function fileWorker(workerId) {
            while (!stopBatch && nextIndex < pending.length) {
                // Capturar índice antes de cualquier await
                const idx = nextIndex;
                nextIndex++;
                const { filename, filePath, fileKey } = pending[idx];
                let stagingDir = null;
                const publishedPaths = [];

                logger.info(`  [WORKER ${workerId}]: procesando ${filename}`);

                try {
                    // No publicar resultados hasta conocer el estado final del TIFF.
                    stagingDir = fs.mkdtempSync(path.join(config.errorDir, '.processing-'));
                    const result = await processFile(filePath, stagingDir);
                    const hasCriticalErrors = result.extractedData?.tiene_errores;
                    const accepted = result.success > 0 && !hasCriticalErrors;
                    const resultsDir = accepted ? config.outputDir : config.errorDir;

                    for (const resultPath of [result.outputPath, result.jsonPath]) {
                        publishedPaths.push(moveFile(resultPath, resultsDir));
                    }

                    if (accepted) {
                        moveFile(filePath, config.processedDir);
                        const historyData = {
                            date: new Date().toISOString(),
                            pages: result.numPages,
                            success: result.success,
                            errors: result.errors,
                            elapsed: result.elapsed,
                            output: path.basename(publishedPaths[0])
                        };

                        try {
                            addToHistory(fileKey, historyData);
                        } catch (historyErr) {
                            logger.error(`[HIST] No se pudo registrar ${filename}: ${historyErr.message}`);
                        }

                        logger.success(`[OK] ${filename} -> processed/`);
                    } else if (result.success > 0 && hasCriticalErrors) {
                        moveFile(filePath, config.errorDir);
                        logger.error(`[LEGAL] ${filename} terminado con errores criticos. TIFF y JSON/TXT en error/.`);
                    } else {
                        moveFile(filePath, config.errorDir);
                        logger.error(`Todas las páginas fallaron para ${filename}. TIFF y JSON/TXT en error/.`);
                    }

                } catch (err) {
                    // Si falló la publicación, retirar de output/ cualquier
                    // resultado parcial y conservarlo junto al TIFF en error/.
                    for (const publishedPath of publishedPaths) {
                        if (!publishedPath.startsWith(config.outputDir + path.sep) || !fs.existsSync(publishedPath)) continue;
                        try {
                            moveFile(publishedPath, config.errorDir);
                        } catch (moveErr) {
                            logger.error(`[OUTPUT] No se pudo retirar ${publishedPath}: ${moveErr.message}`);
                        }
                    }
                    if (stagingDir) {
                        for (const stagedName of fs.readdirSync(stagingDir)) {
                            try {
                                moveFile(path.join(stagingDir, stagedName), config.errorDir);
                            } catch (moveErr) {
                                logger.error(`[OUTPUT] No se pudo conservar ${stagedName} en error/: ${moveErr.message}`);
                            }
                        }
                    }

                    if (isInsufficientQuotaError(err)) {
                        stopBatch = true;
                        openAIQuotaPauseUntil = Date.now() + OPENAI_QUOTA_PAUSE_MS;
                        if (!quotaLogged) {
                            quotaLogged = true;
                            logger.error(`[OPENAI] ${err.message}`);
                            logger.warn('[OPENAI] Lote pausado por cuota insuficiente. Los TIFF quedan en input/ y se reintentara automaticamente en 5 min.');
                        }
                        continue;
                    }

                    logger.error(`Error fatal procesando ${filename}: ${err.message}`);
                    try {
                        moveFile(filePath, config.errorDir);
                    } catch { /* ignore */ }
                } finally {
                    if (stagingDir) {
                        try {
                            fs.rmdirSync(stagingDir);
                        } catch (cleanupErr) {
                            logger.warn(`[OUTPUT] Carpeta temporal pendiente ${stagingDir}: ${cleanupErr.message}`);
                        }
                    }
                }
            }
        }

        const workers = [];
        const numWorkers = Math.min(config.fileConcurrency, pending.length);
        for (let i = 0; i < numWorkers; i++) {
            workers.push(fileWorker(i + 1));
        }
        await Promise.all(workers);

    } finally {
        processing = false;
    }
}

// ── Iniciar el watcher ────────────────────────────────────────────────

/**
 * Inicia el monitor de carpeta (polling) para procesamiento automático.
 */
function startWatcher() {
    // Asegurar que las carpetas existen
    [config.inputDir, config.outputDir, config.processedDir, config.errorDir].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    logger.separator();
    logger.info('[INIT] RPA Vision Watcher iniciado');
    logger.info(`   Input:     ${config.inputDir}`);
    logger.info(`   Output:    ${config.outputDir}`);
    logger.info(`   Processed: ${config.processedDir}`);
    logger.info(`   Error:     ${config.errorDir}`);
    logger.info(`   Intervalo: ${config.watchIntervalMs / 1000}s`);
    logger.info(`   Modelo:    ${config.model}`);
    logger.info(`   Archivos en paralelo: ${config.fileConcurrency}`);
    logger.info(`   Páginas en paralelo:  ${config.concurrency}`);
    logger.separator();
    logger.info('Esperando archivos TIFF en input/... (Ctrl+C para detener)\n');

    // Procesar archivos existentes al iniciar
    loadHistoryMap();
    initHistoryStream();

    // Procesar archivos iniciales
    processPendingFiles();

    // Polling cada X segundos
    const interval = setInterval(async () => {
        await processPendingFiles();
    }, config.watchIntervalMs);

    // Cierre limpio
    const shutdown = async () => {
        logger.info('\n[STOP] Deteniendo watcher...');
        clearInterval(interval);
        if (historyStream) historyStream.end();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

startWatcher();
