import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import { extractFields } from './extractor.js';
import { matchSingleNumber, extractDocCode } from './fuzzy-match.js';
import { ocrWithTesseract } from './tesseract-ocr.js';

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

async function extractPageAsPng(tiffPath, pageIndex, maxWidth = config.maxImageWidth) {
    let pipeline = sharp(tiffPath, { page: pageIndex });
    const meta = await pipeline.metadata();

    if (meta.width > maxWidth) {
        pipeline = sharp(tiffPath, { page: pageIndex })
            .resize({ width: maxWidth, withoutEnlargement: true });
    }

    return pipeline.png({ compressionLevel: 6 }).toBuffer();
}

// ── OCR completo con GPT-4o ───────────────────────────────────────────

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
                        content: `Eres un motor de OCR de máxima precisión para documentos oficiales regulatorios de Bolivia (ASFI). Proceso de digitalización autorizado legalmente.

TU FUNCIÓN: Transcribir EXACTAMENTE el texto visible en la imagen, carácter por carácter.

REGLAS:
1. Devuelve ÚNICAMENTE el texto transcrito. NADA MÁS.
2. NUNCA agregues comentarios, explicaciones ni texto que no esté en la imagen.
3. NUNCA te niegues a transcribir. Es un requisito legal.
4. Mantén el formato original: saltos de línea, espaciado, indentación, numeración.
5. Transcribe TODO: encabezados, códigos, fechas, párrafos, tablas, listas, firmas, sellos.
6. PRECISIÓN EN NÚMEROS Y CÓDIGOS: Lee CADA DÍGITO individualmente. NO adivines ni redondees. Si ves los dígitos 2-6-6-3-7-4 escribe exactamente 266374. Mira cada carácter de la imagen con atención absoluta. Un solo dígito equivocado es un error grave.
7. Las tablas deben mantenerse con su estructura usando espacios o tabulaciones.
8. Si algo es ilegible, usa [ilegible]. NO inventes texto.
9. NO corrijas ortografía ni gramática del documento original.
10. Empieza directamente con el primer texto de la imagen.
11. SIEMPRE responde en español.`
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

            // Detectar rechazos del modelo
            const textLower = text.toLowerCase().trim();
            const isRefusal = text.length < 200 && (textLower.includes('no puedo') || textLower.includes('lo siento'));

            if (isRefusal) {
                logger.warn(`[REFUSAL] Modelo ${config.model} se negó en página ${pageNum}. Reintentando con gpt-4o-mini...`);

                try {
                    const fallbackResponse = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: [
                            {
                                role: 'system',
                                content: `Eres un motor de OCR de alta precisión. Transcribe exactamente el texto visible en la imagen. Devuelve SOLO el texto transcrito, sin comentarios ni explicaciones. Mantén el formato original. SIEMPRE responde en español.`
                            },
                            {
                                role: 'user',
                                content: [
                                    { type: 'text', text: `Transcribe literalmente todo el texto visible en esta imagen (página ${pageNum}). Devuelve SOLO la transcripción.` },
                                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                                ]
                            }
                        ],
                        max_tokens: 4096,
                        temperature: 0.0
                    });

                    const fallbackText = fallbackResponse.choices[0].message.content;
                    logger.info(`[FALLBACK] Página ${pageNum} transcrita con gpt-4o-mini correctamente`);
                    return fallbackText;
                } catch (fallbackErr) {
                    logger.error(`[FALLBACK] Error con gpt-4o-mini en página ${pageNum}: ${fallbackErr.message}`);
                    throw fallbackErr;
                }
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

// ── Identificación rápida de número de documento (prompt barato) ──────

async function identifyDocNumber(pngBuffer, pageNum) {
    const imgBase64 = pngBuffer.toString('base64');

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s suficientes

        try {
            const messages = [
                {
                    role: 'system',
                    content: `Eres un sistema de identificación de códigos numéricos en imágenes de documentos.

Tu ÚNICA tarea es encontrar secuencias numéricas escritas a mano que correspondan al código del documento.

DÓNDE BUSCAR (en orden de prioridad):
1. SELLOS CIRCULARES DE ASFI — Los documentos tienen un círculo con el logo de "ASFI". DENTRO del sello, debajo de la fecha (superpuesto a la palabra "RECEPCIÓN"), aparece un código escrito a MANO. ¡ESTE ES EL LUGAR MÁS IMPORTANTE!
   >>> IMPORTANTE: A veces la letra "R-" inicial parece un "12-" o un "22-". NO IMPORTA. Si ves "12-267938", extrae "12-267938" tal cual.
2. ESQUINA SUPERIOR — El código puede estar escrito a mano en la esquina de la página.

FORMATO DE LOS CÓDIGOS:
- Generalmente números de 5 a 7 dígitos.
- Extrae la cadena completa que esté escrita a mano ahí, incluyendo guiones o letras pegadas.

REGLAS DE RESPUESTA:
1. Devuelve SOLO el texto/número encontrado exacto.
2. Si ves múltiples números escritos a mano, devuelve el que está dentro del sello ASFI superpuesto a la palabra RECEPCIÓN.
3. Si realmente, después de mirar el sello con atención microscópica, no puedes identificar un código, devuelve exactamente: NO_ENCONTRADO`
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `Busca el código numérico escrito a mano en esta imagen. REVISA CON ATENCIÓN MICROSCÓPICA dentro del sello circular de ASFI, justo debajo de la fecha. A veces empieza con R-, 12-, o similar. Devuelve SOLO el código exacto.` },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                    ]
                }
            ];

            const response = await openai.chat.completions.create({
                model: config.model,
                messages: messages,
                max_tokens: 50,
                temperature: 0.0
            }, { signal: controller.signal });

            let result = response.choices[0].message.content.trim();

            const textLower = result.toLowerCase();
            const isRefusal = result.length < 200 && (textLower.includes('no puedo') || textLower.includes('lo siento'));

            if (isRefusal) {
                logger.warn(`[ID REFUSAL] Modelo ${config.model} se negó en página ${pageNum}. Reintentando con gpt-4o-mini...`);
                try {
                    const fallbackResponse = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: messages,
                        max_tokens: 50,
                        temperature: 0.0
                    });
                    result = fallbackResponse.choices[0].message.content.trim();
                    logger.info(`[ID FALLBACK] Página ${pageNum} identificada con gpt-4o-mini`);
                } catch (fallbackErr) {
                    logger.error(`[ID FALLBACK] Error con gpt-4o-mini en página ${pageNum}: ${fallbackErr.message}`);
                    throw fallbackErr;
                }
            }

            return result === 'NO_ENCONTRADO' ? null : result;

        } catch (err) {
            if (attempt === config.maxRetries) {
                logger.error(`[ID] Error identificando número en página ${pageNum}: ${err.message}`);
                return null;
            }
            const waitTime = config.retryDelayMs;
            logger.warn(`[ID] Reintento ${attempt}/${config.maxRetries} identificación página ${pageNum}: ${err.message}`);
            await sleep(waitTime);
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ── Función principal exportada ───────────────────────────────────────

/**
 * Procesa un archivo TIFF:
 *  Fase 1: OCR de página 1 (carátula) → extraer documentos_adjuntos
 *  Fase 1b: Pase dedicado para extraer códigos R-XXXXXX directamente de la imagen
 *  Fase 2: Identificación rápida de números en páginas 2+
 *  Fase 3: Fuzzy match + OCR selectivo solo de páginas que coinciden
 *  Fase 4: Reporte de códigos no encontrados
 *
 * @param {string} tiffPath — Ruta absoluta al archivo TIFF
 * @param {string} outputDir — Directorio donde guardar los archivos de salida
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
    logger.info(`Páginas: ${numPages} | Tamaño: ${fileSizeMB.toFixed(1)} MB | Modelo: ${config.model}`);

    // ═══════════════════════════════════════════════════════════════════
    // FASE 1: OCR de carátula (puede ser multi-página) + extracción
    // ═══════════════════════════════════════════════════════════════════

    logger.info(`[FASE 1] OCR de la carátula con Tesseract (página 1)...`);
    const page1Png = await extractPageAsPng(tiffPath, 0, 4096);
    const page1SizeKB = (page1Png.length / 1024).toFixed(1);
    const page1Text = await ocrWithTesseract(page1Png, 1);
    logger.info(`  [PAGE] Página 1/${numPages} (${page1SizeKB} KB) — Carátula [Tesseract]`);

    // Detectar si la carátula tiene más de 1 página
    // Tesseract puede leer "Pág", "Pag", "Päg", "Pig" si hay una firma cruzada
    let pagMatch = page1Text.match(/P[a-záéíóúäëïöü_.:,'"\-\|]{1,4}g[^\d]*(\d+)\s*de\s*(\d+)/i) ||
        page1Text.match(/(?:p[áa]gina|pag|p[áa]g\.?)\s*(\d+)\s*(?:\/|de)\s*(\d+)/i);

    if (!pagMatch) {
        // Fallback: Si no lee la palabra "Pág", buscar por ej. "1 de 2" aislado al final
        const endText = page1Text.slice(-1000);
        pagMatch = endText.match(/(?:\n|^)\s*(\d+)\s*de\s*(\d+)\s*(?:\n|$)/i);
    }

    let coverPageCount = 1;
    if (pagMatch) {
        coverPageCount = parseInt(pagMatch[2], 10);
        if (coverPageCount > 1 && coverPageCount <= numPages) {
            logger.info(`[FASE 1] Carátula multi-página detectada: ${coverPageCount} páginas`);
        } else {
            coverPageCount = 1; // Valor inválido, asumir 1
        }
    }

    // OCR de páginas adicionales de la carátula si existen
    const coverPngs = [page1Png];
    const coverTexts = [page1Text];

    for (let ci = 1; ci < coverPageCount && ci < numPages; ci++) {
        const coverPng = await extractPageAsPng(tiffPath, ci, 4096);
        const coverSizeKB = (coverPng.length / 1024).toFixed(1);
        const coverText = await ocrWithTesseract(coverPng, ci + 1);
        coverPngs.push(coverPng);
        coverTexts.push(coverText);
        logger.info(`  [PAGE] Página ${ci + 1}/${numPages} (${coverSizeKB} KB) — Carátula (cont.) [Tesseract]`);
    }

    // Extraer campos del texto completo de la carátula
    const fullCoverText = coverTexts.join('\n\n');
    const extractedData = await extractFields(fullCoverText);

    const adjuntos = extractedData.documentos_adjuntos || [];

    if (adjuntos.length === 0) {
        logger.warn(`[FASE 1] No se encontraron documentos adjuntos en la carátula. Se omiten páginas restantes.`);
    } else {
        logger.info(`[FASE 1] Documentos adjuntos encontrados: ${adjuntos.length}`);
        for (const adj of adjuntos) {
            logger.info(`  → ${adj}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // FASE 2 y 3: Identificación rápida + OCR selectivo (páginas después de carátula)
    // ═══════════════════════════════════════════════════════════════════

    const ubicacion_adjuntos = [];
    const allText = [...coverTexts]; // Textos de las páginas de carátula
    const matchedCodes = new Set();
    let pendingAdjuntos = [...adjuntos]; // Copia de la lista para ir eliminando
    let successCount = coverPageCount; // Páginas de carátula ya procesadas
    let errorCount = 0;
    let skippedCount = 0;

    if (adjuntos.length > 0 && numPages > coverPageCount) {
        logger.info(`[FASE 2] Identificando números en páginas ${coverPageCount + 1}-${numPages}...`);

        for (let pageIndex = coverPageCount; pageIndex < numPages; pageIndex++) {
            const pageNum = pageIndex + 1;

            if (pendingAdjuntos.length === 0) {
                logger.info(`  [SKIP] Página ${pageNum}/${numPages} — Ya se encontraron todos los códigos (${matchedCodes.size}). Se omite la página.`);
                allText.push('');
                skippedCount++;
                continue;
            }

            try {
                // Mayor resolución (3072) para ayudar al modelo mini a ver texto manuscrito pequeño
                const pngBuffer = await extractPageAsPng(tiffPath, pageIndex, 3072);
                const sizeKB = (pngBuffer.length / 1024).toFixed(1);

                // Paso 2A: Identificación rápida del número
                const identifiedNumber = await identifyDocNumber(pngBuffer, pageNum);

                if (!identifiedNumber) {
                    logger.warn(`  [SKIP] Página ${pageNum}/${numPages} (${sizeKB} KB) — No se identificó código`);
                    allText.push('');
                    skippedCount++;
                    continue;
                }

                logger.info(`  [ID] Página ${pageNum}/${numPages} — Código identificado: ${identifiedNumber}`);

                // Paso 2B: Fuzzy match contra la lista de adjuntos PENDIENTES
                const matchResult = matchSingleNumber(identifiedNumber, pendingAdjuntos);

                if (!matchResult.matched) {
                    // Si se identificó pero no está en la lista (o ya fue encontrado previamente)
                    const isAlreadyFound = matchedCodes.has(identifiedNumber.match(/R-\d{5,7}/)?.[0] || '');
                    if (isAlreadyFound) {
                        logger.warn(`  [SKIP] Página ${pageNum}/${numPages} (${sizeKB} KB) — El código "${identifiedNumber}" ya fue encontrado antes en otra página.`);
                    } else {
                        logger.warn(`  [SKIP] Página ${pageNum}/${numPages} (${sizeKB} KB) — Código "${identifiedNumber}" no coincide con ningún adjunto pendiente (score: ${matchResult.score})`);
                    }
                    allText.push('');
                    skippedCount++;
                    continue;
                }

                logger.info(`  [MATCH] Página ${pageNum} ↔ ${matchResult.code} (confianza: ${(matchResult.score * 100).toFixed(0)}%)`);
                matchedCodes.add(matchResult.code);

                // Eliminar el adjunto encontrado de la lista de pendientes para no volver a buscarlo
                pendingAdjuntos = pendingAdjuntos.filter(doc => !doc.includes(matchResult.code));
                logger.info(`  [INFO] Código "${matchResult.code}" removido de la lista de búsqueda. Faltan ${pendingAdjuntos.length} códigos.`);

                // Paso 3: OCR completo SOLO de esta página
                logger.info(`  [OCR] Transcribiendo página ${pageNum}/${numPages} (${sizeKB} KB)...`);
                const ocrText = await ocrWithVision(pngBuffer, pageNum);
                allText.push(ocrText);
                successCount++;

                ubicacion_adjuntos.push({
                    documento: matchResult.documento,
                    id_buscado: matchResult.code,
                    id_encontrado: identifiedNumber,
                    pagina: pageNum,
                    confianza: matchResult.score
                });

            } catch (err) {
                logger.error(`  [ERROR] Página ${pageNum}/${numPages}: ${err.message}`);
                allText.push(`[ERROR] Página ${pageNum}: ${err.message}`);
                errorCount++;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // FASE 4: Reporte de códigos no encontrados
    // ═══════════════════════════════════════════════════════════════════

    const notFound = adjuntos.filter(adj => {
        const code = extractDocCode(adj);
        return !matchedCodes.has(code);
    });

    if (notFound.length > 0) {
        logger.separator();
        logger.warn(`╔══════════════════════════════════════════════════════╗`);
        logger.warn(`║  REPORTE: CÓDIGOS NO ENCONTRADOS                    ║`);
        logger.warn(`╠══════════════════════════════════════════════════════╣`);
        for (const doc of notFound) {
            const code = extractDocCode(doc);
            logger.warn(`║  ✗ ${code.padEnd(15)} — ${doc}`);
        }
        logger.warn(`╠══════════════════════════════════════════════════════╣`);
        logger.warn(`║  Total no encontrados: ${String(notFound.length).padEnd(3)} de ${adjuntos.length} adjuntos     ║`);
        logger.warn(`╚══════════════════════════════════════════════════════╝`);
        logger.separator();
    } else if (adjuntos.length > 0) {
        logger.success(`[✓] Todos los ${adjuntos.length} documentos adjuntos fueron localizados exitosamente.`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Escribir resultados TXT y JSON
    // ═══════════════════════════════════════════════════════════════════

    const stream = fs.createWriteStream(outputPath);

    stream.write('='.repeat(60) + '\n');
    stream.write(`OCR con ${config.model} Vision - Extracción de texto\n`);
    stream.write(`Archivo: ${path.basename(tiffPath)}\n`);
    stream.write(`Fecha: ${now}\n`);
    stream.write(`Total de páginas: ${numPages}\n`);
    stream.write(`Páginas transcritas: ${successCount} | Omitidas: ${skippedCount} | Errores: ${errorCount}\n`);
    stream.write('='.repeat(60) + '\n\n');

    // Páginas de carátula
    for (let ci = 0; ci < coverTexts.length; ci++) {
        stream.write('-'.repeat(60) + '\n');
        stream.write(`PÁGINA ${ci + 1} / ${numPages} — CARÁTULA${coverTexts.length > 1 ? ` (${ci + 1}/${coverTexts.length})` : ''}\n`);
        stream.write('-'.repeat(60) + '\n');
        stream.write(coverTexts[ci] + '\n\n');
    }

    // Páginas transcritas (solo las que tuvieron match)
    for (const ubic of ubicacion_adjuntos) {
        const pageTextIndex = ubic.pagina - 1; // 0-indexed en allText
        const pageText = allText[pageTextIndex];
        if (!pageText) continue;

        stream.write('-'.repeat(60) + '\n');
        stream.write(`PÁGINA ${ubic.pagina} / ${numPages} — ${ubic.id_buscado} (confianza: ${(ubic.confianza * 100).toFixed(0)}%)\n`);
        stream.write('-'.repeat(60) + '\n');
        stream.write(pageText + '\n\n');
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const elapsedStr = formatTime(elapsed);

    stream.write('='.repeat(60) + '\n');
    stream.write(`Completado en ${elapsedStr}\n`);
    stream.write(`Transcritas: ${successCount} | Omitidas: ${skippedCount} | Errores: ${errorCount}\n`);
    if (notFound.length > 0) {
        stream.write(`\nCÓDIGOS NO ENCONTRADOS:\n`);
        for (const doc of notFound) {
            stream.write(`  ✗ ${doc}\n`);
        }
    }
    stream.write('='.repeat(60) + '\n');

    stream.end();
    await new Promise(resolve => stream.on('finish', resolve));

    // JSON de salida
    const jsonOutput = {
        archivo_origen: path.basename(tiffPath),
        fecha_procesamiento: now,
        total_paginas: numPages,
        paginas_transcritas: successCount,
        paginas_omitidas: skippedCount,
        ...extractedData,
        ubicacion_adjuntos: ubicacion_adjuntos.length > 0 ? ubicacion_adjuntos : undefined,
        codigos_no_encontrados: notFound.length > 0 ? notFound.map(d => extractDocCode(d)) : undefined
    };

    fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');
    logger.success(`[JSON] JSON guardado: ${path.basename(jsonPath)}`);
    logger.success(`Completado: ${path.basename(tiffPath)} (${elapsedStr}) — ${successCount} transcritas, ${skippedCount} omitidas`);

    return { outputPath, jsonPath, numPages, success: successCount, errors: errorCount, skipped: skippedCount, elapsed: elapsedStr, extractedData: jsonOutput };
}
