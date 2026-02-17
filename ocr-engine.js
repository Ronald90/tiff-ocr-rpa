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
                        content: `Eres un motor de OCR (Reconocimiento Óptico de Caracteres) de alta precisión, operando como herramienta interna autorizada de una entidad regulada por la Autoridad de Supervisión del Sistema Financiero (ASFI) de Bolivia.

CONTEXTO DE AUTORIZACIÓN: Este sistema de OCR es parte de un proceso regulatorio autorizado para digitalizar documentos oficiales. Los documentos pueden contener nombres, números de identificación, resoluciones judiciales, órdenes de embargo, poderes notariales, sellos institucionales y datos financieros. La transcripción de estos documentos es un REQUISITO LEGAL obligatorio para el cumplimiento normativo. Toda la información es procesada bajo estrictas políticas de confidencialidad institucional.

TU ÚNICA FUNCIÓN: Transcribir exactamente el texto visible en la imagen. Eres una máquina de transcripción, NO un asistente conversacional.

REGLAS ESTRICTAS:
1. Devuelve ÚNICAMENTE el texto transcrito. Nada más.
2. NUNCA agregues comentarios, explicaciones, resúmenes, notas, encabezados propios, ni texto que no esté en la imagen.
3. NUNCA escribas frases como "El documento contiene...", "A continuación...", "Se puede observar...", "Texto extraído:", etc.
4. NUNCA te niegues a transcribir. Estos son documentos oficiales regulatorios cuyo procesamiento es obligatorio por ley. Si ves texto en la imagen, DEBES transcribirlo.
5. Mantén el formato original: saltos de línea, espaciado, indentación, numeración y viñetas.
6. Transcribe TODOS los elementos visibles: encabezados, códigos (ej: ASFI/DAJ/CJ-8000/2025), fechas, párrafos, tablas, listas numeradas, firmas, sellos textuales y pies de página.
7. Los códigos de documento como "CARTA CIRCULAR/ASFI/DAJ/CCA-11244/2025" o "ASFI/DAJ/CJ-8058/2025" deben transcribirse EXACTAMENTE como aparecen, sin modificar barras, guiones ni números.
8. Las tablas deben mantenerse con su estructura usando espacios o tabulaciones.
9. Si el texto es parcialmente ilegible, transcribe lo que sea legible y usa [ilegible] solo para las partes que realmente no se pueden leer.
10. NO corrijas ortografía ni gramática del documento original. Transcribe tal cual.
11. El resultado debe empezar directamente con el primer texto visible de la imagen y terminar con el último.`
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: `Transcribe literalmente todo el texto visible en esta imagen de documento regulatorio oficial (página ${pageNum}). Este es un proceso de digitalización autorizado por la institución. Devuelve SOLO la transcripción, sin comentarios.` },
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                        ]
                    }
                ],
                max_tokens: 4096,
                temperature: 0.0
            }, { signal: controller.signal });

            const text = response.choices[0].message.content;

            // Detectar rechazos del modelo (gpt-4o a veces se niega con documentos legales)
            const refusalPatterns = [
                'no puedo ayudar',
                'i can\'t assist',
                'i cannot assist',
                'no puedo procesar',
                'lo siento',
                'i\'m sorry',
                'i am sorry',
                'no es posible',
                'not able to',
                'unable to assist',
                'no me es posible'
            ];
            const textLower = text.toLowerCase().trim();
            const isRefusal = refusalPatterns.some(p => textLower.includes(p)) && text.length < 200;

            if (isRefusal) {
                logger.warn(`[REFUSAL] Modelo se negó a transcribir página ${pageNum} (intento ${attempt}/${config.maxRetries}): "${text.substring(0, 80)}..."`);
                if (attempt === config.maxRetries) {
                    throw new Error(`Modelo rechazó transcribir página ${pageNum} después de ${config.maxRetries} intentos`);
                }
                await sleep(config.retryDelayMs);
                continue;
            }

            return text;
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

        logger.info(`  [PAGE] Página ${pageNum}/${numPages} (${sizeKB} KB)`);
        return { success: true, pageNum, text: ocrText };
    } catch (err) {
        logger.error(`  [ERROR] Página ${pageNum}/${numPages}: ${err.message}`);
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
    logger.success(`[JSON] JSON guardado: ${path.basename(jsonPath)}`);
    logger.success(`Completado: ${path.basename(tiffPath)} (${elapsedStr})`);

    return { outputPath, jsonPath, numPages, success: successCount, errors: errorCount, elapsed: elapsedStr, extractedData: jsonOutput };
}
