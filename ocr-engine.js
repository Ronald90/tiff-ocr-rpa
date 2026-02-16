import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import { extractFields } from './extractor.js';

// ── Utilidades ────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Extracción de página ──────────────────────────────────────────────

async function extractPageAsPng(tiffPath, pageIndex) {
    let pipeline = sharp(tiffPath, { page: pageIndex });
    const meta = await pipeline.metadata();

    if (meta.width > config.maxImageWidth) {
        pipeline = sharp(tiffPath, { page: pageIndex })
            .resize({ width: config.maxImageWidth, withoutEnlargement: true });
    }

    return pipeline.png({ compressionLevel: 6 }).toBuffer();
}

// ── OCR con GPT-4o ────────────────────────────────────────────────────

async function ocrWithVision(pngBuffer, pageNum) {
    const imgBase64 = pngBuffer.toString('base64');

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutPerPageMs);

        try {
            const response = await openai.chat.completions.create({
                model: config.model,
                messages: [
                    {
                        role: 'system',
                        content: 'Eres un sistema de OCR profesional. Tu tarea es extraer TODO el texto visible en la imagen, manteniendo el formato original lo más fielmente posible. Incluye encabezados, párrafos, tablas, números, y cualquier texto visible. No agregues comentarios ni explicaciones, solo devuelve el texto extraído tal cual aparece en el documento.'
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: `Extrae todo el texto de esta imagen de documento (página ${pageNum}). Devuelve SOLO el texto, sin comentarios adicionales.` },
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                        ]
                    }
                ],
                max_tokens: 4096,
                temperature: 0.0
            }, { signal: controller.signal });

            return response.choices[0].message.content;
        } catch (err) {
            if (attempt === config.maxRetries) throw err;

            const isRateLimit = err.status === 429;
            const waitTime = isRateLimit ? config.retryDelayMs * attempt : config.retryDelayMs;
            const detail = err.code || err.cause?.code || err.message;
            logger.warn(`Reintento ${attempt}/${config.maxRetries} para página ${pageNum}: ${detail} (espera ${waitTime / 1000}s)`);
            await sleep(waitTime);
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ── Procesar una página ───────────────────────────────────────────────

async function processPage(tiffPath, pageIndex, numPages) {
    const pageNum = pageIndex + 1;

    try {
        const pngBuffer = await extractPageAsPng(tiffPath, pageIndex);
        const sizeKB = (pngBuffer.length / 1024).toFixed(1);
        const ocrText = await ocrWithVision(pngBuffer, pageNum);

        logger.info(`  ✅ Página ${pageNum}/${numPages} (${sizeKB} KB)`);
        return { success: true, pageNum, text: ocrText };
    } catch (err) {
        logger.error(`  ❌ Página ${pageNum}/${numPages}: ${err.message}`);
        return { success: false, pageNum, text: `[ERROR] Página ${pageNum}: ${err.message}` };
    }
}

// ── Worker pool con concurrencia ──────────────────────────────────────

async function processAllPages(tiffPath, numPages) {
    const results = new Array(numPages);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < numPages) {
            const index = nextIndex++;
            results[index] = await processPage(tiffPath, index, numPages);
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(config.concurrency, numPages); i++) {
        workers.push(worker());
    }

    await Promise.all(workers);
    return results;
}

// ── Función principal exportada ───────────────────────────────────────

/**
 * Procesa un archivo TIFF y genera un archivo .txt con el OCR + un .json con datos extraídos.
 * @param {string} tiffPath — Ruta absoluta al archivo TIFF
 * @param {string} outputDir — Directorio donde guardar los archivos de salida
 * @returns {{ outputPath: string, jsonPath: string, numPages: number, success: number, errors: number, elapsed: string, extractedData: object }}
 */
export async function processFile(tiffPath, outputDir) {
    const startTime = Date.now();
    const d = new Date();
    const now = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const ext = path.extname(tiffPath);
    const baseName = path.basename(tiffPath, ext);
    const outputPath = path.join(outputDir, `${baseName}_ocr.txt`);
    const jsonPath = path.join(outputDir, `${baseName}_datos.json`);

    logger.separator();
    logger.info(`Procesando: ${path.basename(tiffPath)}`);

    // Validar tamaño de archivo
    const fileStat = fs.statSync(tiffPath);
    const fileSizeMB = fileStat.size / (1024 * 1024);
    if (fileSizeMB > config.maxFileSizeMB) {
        throw new Error(`Archivo demasiado grande: ${fileSizeMB.toFixed(1)} MB (máximo: ${config.maxFileSizeMB} MB)`);
    }

    // Obtener número de páginas
    const metadata = await sharp(tiffPath).metadata();
    const numPages = metadata.pages || 1;
    logger.info(`Páginas: ${numPages} | Tamaño: ${fileSizeMB.toFixed(1)} MB | Concurrencia: ${config.concurrency} | Modelo: ${config.model}`);

    // Procesar todas las páginas
    const results = await processAllPages(tiffPath, numPages);

    // Escribir resultados TXT
    const stream = fs.createWriteStream(outputPath);

    stream.write('='.repeat(60) + '\n');
    stream.write(`OCR con ${config.model} Vision - Extracción de texto\n`);
    stream.write(`Archivo: ${path.basename(tiffPath)}\n`);
    stream.write(`Fecha: ${now}\n`);
    stream.write(`Total de páginas: ${numPages}\n`);
    stream.write('='.repeat(60) + '\n\n');

    let successCount = 0;
    let errorCount = 0;
    const allText = [];

    for (const result of results) {
        stream.write('-'.repeat(60) + '\n');
        stream.write(`PÁGINA ${result.pageNum} / ${numPages}\n`);
        stream.write('-'.repeat(60) + '\n');
        stream.write(result.text + '\n\n');

        if (result.success) {
            successCount++;
            allText.push(result.text);
        } else {
            errorCount++;
        }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const elapsedStr = formatTime(elapsed);

    stream.write('='.repeat(60) + '\n');
    stream.write(`Completado en ${elapsedStr}\n`);
    stream.write(`Exitosas: ${successCount} | Errores: ${errorCount}\n`);
    stream.write('='.repeat(60) + '\n');

    stream.end();
    await new Promise(resolve => stream.on('finish', resolve));

    // Extraer campos estructurados del texto OCR
    const fullText = allText.join('\n\n');
    const extractedData = await extractFields(fullText);

    // Agregar metadatos al JSON
    const jsonOutput = {
        archivo_origen: path.basename(tiffPath),
        fecha_procesamiento: now,
        total_paginas: numPages,
        ...extractedData
    };

    fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');
    logger.success(`📄 JSON guardado: ${path.basename(jsonPath)}`);
    logger.success(`Completado: ${path.basename(tiffPath)} (${elapsedStr})`);

    return { outputPath, jsonPath, numPages, success: successCount, errors: errorCount, elapsed: elapsedStr, extractedData: jsonOutput };
}
