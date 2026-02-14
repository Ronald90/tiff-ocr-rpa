import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import { processFile } from './ocr-engine.js';

// ── Estado del watcher ────────────────────────────────────────────────

const HISTORY_FILE = path.resolve('./.processed_history.json');
let processing = false;

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        }
    } catch { /* ignore */ }
    return {};
}

function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
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
        const history = loadHistory();
        const files = fs.readdirSync(config.inputDir).filter(isTiff);

        if (files.length === 0) return;

        logger.info(`📂 Encontrados ${files.length} archivo(s) TIFF en input/`);

        for (const filename of files) {
            const filePath = path.join(config.inputDir, filename);

            // Verificar si ya fue procesado (por nombre + tamaño)
            const stat = fs.statSync(filePath);
            const fileKey = `${filename}::${stat.size}`;

            if (history[fileKey]) {
                logger.warn(`Saltando ${filename} (ya procesado el ${history[fileKey].date})`);

                // Moverlo a processed de todas formas
                try {
                    moveFile(filePath, config.processedDir);
                } catch { /* podría haber sido removido */ }
                continue;
            }

            // Procesar el archivo
            try {
                const result = await processFile(filePath, config.outputDir);

                // Registrar en historial
                history[fileKey] = {
                    date: new Date().toISOString(),
                    pages: result.numPages,
                    success: result.success,
                    errors: result.errors,
                    elapsed: result.elapsed,
                    output: path.basename(result.outputPath)
                };
                saveHistory(history);

                // Mover a processed
                moveFile(filePath, config.processedDir);
                logger.success(`📁 ${filename} → processed/`);

            } catch (err) {
                logger.error(`Error fatal procesando ${filename}: ${err.message}`);

                // Mover a error
                try {
                    moveFile(filePath, config.errorDir);
                    logger.warn(`📁 ${filename} → error/`);
                } catch (moveErr) {
                    logger.error(`No se pudo mover ${filename} a error/: ${moveErr.message}`);
                }
            }
        }
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
    logger.info('🤖 RPA OCR Watcher iniciado');
    logger.info(`   Input:     ${config.inputDir}`);
    logger.info(`   Output:    ${config.outputDir}`);
    logger.info(`   Processed: ${config.processedDir}`);
    logger.info(`   Error:     ${config.errorDir}`);
    logger.info(`   Intervalo: ${config.watchIntervalMs / 1000}s`);
    logger.info(`   Modelo:    ${config.model}`);
    logger.separator();
    logger.info('Esperando archivos TIFF en input/... (Ctrl+C para detener)\n');

    // Procesar archivos existentes al iniciar
    processPendingFiles();

    // Polling cada X segundos
    const interval = setInterval(async () => {
        await processPendingFiles();
    }, config.watchIntervalMs);

    // Cierre limpio
    process.on('SIGINT', () => {
        logger.info('\n🛑 Deteniendo watcher...');
        clearInterval(interval);
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        logger.info('\n🛑 Deteniendo watcher...');
        clearInterval(interval);
        process.exit(0);
    });
}

startWatcher();
