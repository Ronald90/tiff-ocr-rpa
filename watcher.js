import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';
import { processFile } from './ocr-engine.js';

// ── Estado del watcher ────────────────────────────────────────────────

const HISTORY_FILE = path.resolve('./.processed_history.jsonl');
const historyMap = new Map();
let historyStream = null;
let processing = false;

// Cargar historial en memoria al inicio (reconstruir desde log)
function loadHistoryMap() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
            const lines = content.split('\n');
            let loaded = 0;
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    // Suponemos que el objeto tiene formato { key: "...", data: {...} }
                    if (entry.key && entry.data) {
                        historyMap.set(entry.key, entry.data);
                        loaded++;
                    }
                } catch { /* ignore corrupted lines */ }
            }
            logger.info(`[HIST] Historial cargado: ${loaded} archivos procesados previos.`);
        }
    } catch (err) {
        logger.error(`Error cargando historial: ${err.message}`);
    }
}

// Inicializar stream de escritura (append-only)
function initHistoryStream() {
    historyStream = fs.createWriteStream(HISTORY_FILE, { flags: 'a', encoding: 'utf8' });
}

// Agregar al historial (Memoria + Disco)
function addToHistory(key, data) {
    historyMap.set(key, data);
    if (historyStream) {
        const line = JSON.stringify({ key, data });
        historyStream.write(line + '\n');
    }
}

function isTiff(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.tif', '.tiff'].includes(ext);
}

// ── Mover archivo ─────────────────────────────────────────────────────

function moveFile(src, destDir) {
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

async function processPendingFiles() {
    if (processing) return;
    processing = true;

    try {
        // Optimización: No leer directorio si ya estamos full de trabajo? 
        // En este diseño simple leemos y filtramos. Para 2000 archivos es manejeable 
        // si no re-leemos el historial de disco cada vez.

        const allFiles = fs.readdirSync(config.inputDir).filter(isTiff);
        if (allFiles.length === 0) return;

        // Filtrar archivos YA procesados usando el Map en memoria
        const pending = [];

        for (const filename of allFiles) {
            // Si ya llenamos el batch, paramos de analizar para no bloquear
            if (pending.length >= config.maxBatchSize) break;

            const filePath = path.join(config.inputDir, filename);

            try {
                const stat = fs.statSync(filePath);

                // Hash parcial para identificación única
                const buf = Buffer.alloc(4096);
                const fd = fs.openSync(filePath, 'r');
                const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
                fs.closeSync(fd);

                const partialHash = crypto
                    .createHash('md5')
                    .update(buf.subarray(0, bytesRead))
                    .digest('hex')
                    .substring(0, 8);

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

        // Worker pool
        let nextIndex = 0;

        async function fileWorker(workerId) {
            while (nextIndex < pending.length) {
                const idx = nextIndex++;
                const { filename, filePath, fileKey } = pending[idx];

                logger.info(`  [WORKER ${workerId}]: procesando ${filename}`);

                try {
                    const result = await processFile(filePath, config.outputDir);

                    if (result.success > 0) {
                        const historyData = {
                            date: new Date().toISOString(),
                            pages: result.numPages,
                            success: result.success,
                            errors: result.errors,
                            elapsed: result.elapsed,
                            output: path.basename(result.outputPath)
                        };

                        // Guardar en historial optimizado
                        addToHistory(fileKey, historyData);

                        moveFile(filePath, config.processedDir);
                        logger.success(`[OK] ${filename} -> processed/`);
                    } else {
                        logger.error(`Todas las páginas fallaron para ${filename}`);
                        moveFile(filePath, config.errorDir);
                    }

                } catch (err) {
                    logger.error(`Error fatal procesando ${filename}: ${err.message}`);
                    try {
                        moveFile(filePath, config.errorDir);
                    } catch { /* ignore */ }
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

function startWatcher() {
    // Asegurar que las carpetas existen
    [config.inputDir, config.outputDir, config.processedDir, config.errorDir].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    logger.separator();
    logger.info('[INIT] RPA OCR Watcher iniciado');
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
    const shutdown = () => {
        logger.info('\n[STOP] Deteniendo watcher...');
        clearInterval(interval);
        if (historyStream) historyStream.end();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

startWatcher();
