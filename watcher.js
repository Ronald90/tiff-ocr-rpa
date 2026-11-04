import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';
import { processFile } from './ocr-engine.js';
import { preserveIncompleteOutputs } from './incomplete-result.js';
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

        // Todo TIFF colocado de nuevo en input/ es un nuevo intento. El
        // historial registra resultados, pero no bloquea la validación.
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
                    logger.info(`[REPROCESS] ${filename} ya figura en el historial; se procesara otra vez porque esta en input/.`);
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
                let incompleteBundleDir = null;
                const publishedPaths = [];

                logger.info(`  [WORKER ${workerId}]: procesando ${filename}`);

                try {
                    // No publicar resultados hasta conocer el estado final del TIFF.
                    stagingDir = fs.mkdtempSync(path.join(config.errorDir, '.processing-'));
                    const result = await processFile(filePath, stagingDir);
                    const data = result.extractedData || {};
                    const adjuntos = data.ubicacion_adjuntos || [];
                    const revisiones = adjuntos.filter(adjunto => adjunto._revision).length;
                    const fallidos = adjuntos.filter(adjunto => adjunto._error).length;
                    logger.info(`[RESUMEN] ${filename}: ${result.success}/${result.numPages} pagina(s) transcrita(s), ${adjuntos.length}/${data.documentos_adjuntos?.length || 0} adjunto(s) localizado(s), ${adjuntos.length - revisiones - fallidos} completo(s), ${revisiones} por revisar, ${fallidos} con error de extraccion, ${result.errors} fallo(s) de lectura o extraccion.`);
                    const accepted = result.success > 0 && data.estado_procesamiento === 'completo';

                    if (accepted) {
                        for (const resultPath of [result.outputPath, result.jsonPath]) {
                            publishedPaths.push(moveFile(resultPath, config.outputDir));
                        }
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
                    } else if (data.estado_procesamiento === 'incompleto') {
                        incompleteBundleDir = preserveIncompleteOutputs(
                            stagingDir, config.errorDir, filename, result.outputPath, result.jsonPath
                        );
                        stagingDir = null;
                        moveFile(filePath, incompleteBundleDir);
                        const reasons = data.motivos_incompleto || ['Procesamiento sin terminar'];
                        logger.warn(`[INCOMPLETO] ${filename}: ${reasons.length} punto(s) pendiente(s). TIFF, TXT y JSON parciales guardados en ${incompleteBundleDir}; no son resultados aprobados.`);
                        for (const reason of reasons) logger.warn(`  [PENDIENTE] ${reason}`);
                    } else {
                        moveFile(filePath, config.errorDir);
                        logger.warn(`[INCOMPLETO] ${filename}: no se obtuvo un resultado completo. Solo el TIFF se mueve a ${config.errorDir}.`);
                    }

                } catch (err) {
                    // Si falló la publicación, retirar de output/ cualquier
                    // resultado parcial. Los resultados fallidos no se conservan.
                    for (const publishedPath of publishedPaths) {
                        if (!publishedPath.startsWith(config.outputDir + path.sep) || !fs.existsSync(publishedPath)) continue;
                        try {
                            fs.unlinkSync(publishedPath);
                        } catch (removeErr) {
                            logger.error(`[OUTPUT] No se pudo retirar ${publishedPath}: ${removeErr.message}`);
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

                    logger.warn(`[INCOMPLETO] ${filename}: procesamiento interrumpido: ${err.message}`);
                    if (incompleteBundleDir) logger.warn(`[PARCIAL] Resultados recuperables en ${incompleteBundleDir}`);
                    try {
                        moveFile(filePath, config.errorDir);
                    } catch { /* ignore */ }
                } finally {
                    if (stagingDir) {
                        try {
                            for (const stagedName of fs.readdirSync(stagingDir)) {
                                fs.unlinkSync(path.join(stagingDir, stagedName));
                            }
                            fs.rmdirSync(stagingDir);
                        } catch (cleanupErr) {
                            logger.error(`[OUTPUT] No se pudo limpiar ${stagingDir}: ${cleanupErr.message}`);
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
    logger.info(`   Incompletos: ${config.errorDir}`);
    logger.info(`   Caché API: ${config.ocrCacheDir || 'desactivada (configura OCR_CACHE_DIR en .env)'}`);
    logger.info(`   Confirmaciones R: ${config.manualCodeConfirmationsFile || 'desactivadas (configura MANUAL_CODE_CONFIRMATIONS_FILE en .env)'}`);
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
