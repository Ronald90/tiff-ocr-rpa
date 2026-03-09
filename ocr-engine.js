import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import { extractFields } from './extractor.js';
import { extractAdjuntoFields } from './adjunto-extractor.js';
import { matchSingleNumber, extractDocCode } from './fuzzy-match.js';
import { ocrWithTesseract } from './tesseract-ocr.js';

// ── Cargar prompts desde archivos externos ────────────────────────────

const PROMPTS = {
    ocrVisionSystem: fs.readFileSync(path.resolve('./prompts/ocr_vision_system.txt'), 'utf-8'),
    ocrVisionUser: fs.readFileSync(path.resolve('./prompts/ocr_vision_user.txt'), 'utf-8'),
    ocrVisionFallbackSystem: fs.readFileSync(path.resolve('./prompts/ocr_vision_fallback_system.txt'), 'utf-8'),
    ocrVisionFallbackUser: fs.readFileSync(path.resolve('./prompts/ocr_vision_fallback_user.txt'), 'utf-8'),
    idDocSystem: fs.readFileSync(path.resolve('./prompts/id_doc_system.txt'), 'utf-8'),
    idDocUser: fs.readFileSync(path.resolve('./prompts/id_doc_user.txt'), 'utf-8'),
    idDocRetrySystem: fs.readFileSync(path.resolve('./prompts/id_doc_retry_system.txt'), 'utf-8'),
    idDocRetryUser: fs.readFileSync(path.resolve('./prompts/id_doc_retry_user.txt'), 'utf-8'),
};

/**
 * Reemplaza marcadores {{variable}} en un template de prompt.
 */
function renderPrompt(template, vars = {}) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }
    return result;
}

// ── Utilidades ────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Normaliza texto OCR para mejorar la deteccion de patrones regex.
 * Unifica guiones, colapsa espacios y estandariza formato R-.
 */
function normalizeOCR(text = '') {
    return text
        .replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/([Rr])\s*[-_.]\s*/g, 'R-')
        .trim();
}

// ── Extraccion de pagina ──────────────────────────────────────────────

async function extractPageAsPng(tiffPath, pageIndex, maxWidth = config.maxImageWidth) {
    let pipeline = sharp(tiffPath, { page: pageIndex });
    const meta = await pipeline.metadata();

    if (meta.width > maxWidth) {
        pipeline = sharp(tiffPath, { page: pageIndex })
            .resize({ width: maxWidth, withoutEnlargement: true });
    }

    return pipeline.png({ compressionLevel: 6 }).toBuffer();
}

// ── Mejora de imagen para texto manuscrito ─────────────────────────────

/**
 * Preprocesa una imagen PNG para mejorar la visibilidad de texto manuscrito.
 * Convierte a escala de grises, normaliza brillo, aumenta contraste y nitidez.
 */
async function enhanceForHandwriting(pngBuffer) {
    return sharp(pngBuffer)
        .greyscale()
        .normalize()
        .sharpen({ sigma: 2 })
        .linear(1.5, 0)
        .png()
        .toBuffer();
}

/**
 * Recorta la seccion superior de la imagen donde tipicamente esta el sello ASFI.
 * @param {Buffer} pngBuffer
 * @param {number} fraction - Fraccion superior a conservar (0.40 = 40% superior)
 */
async function cropTopSection(pngBuffer, fraction = 0.40) {
    const meta = await sharp(pngBuffer).metadata();
    const cropHeight = Math.floor(meta.height * fraction);
    return sharp(pngBuffer)
        .extract({ left: 0, top: 0, width: meta.width, height: cropHeight })
        .png()
        .toBuffer();
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
                        content: PROMPTS.ocrVisionSystem
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: renderPrompt(PROMPTS.ocrVisionUser, { pageNum }) },
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
                logger.warn(`[REFUSAL] Modelo ${config.model} se nego en pagina ${pageNum}. Reintentando con gpt-4o-mini...`);

                try {
                    const fallbackResponse = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: [
                            {
                                role: 'system',
                                content: PROMPTS.ocrVisionFallbackSystem
                            },
                            {
                                role: 'user',
                                content: [
                                    { type: 'text', text: renderPrompt(PROMPTS.ocrVisionFallbackUser, { pageNum }) },
                                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                                ]
                            }
                        ],
                        max_tokens: 4096,
                        temperature: 0.0
                    });

                    const fallbackText = fallbackResponse.choices[0].message.content;
                    logger.info(`[FALLBACK] Pagina ${pageNum} transcrita con gpt-4o-mini correctamente`);
                    return fallbackText;
                } catch (fallbackErr) {
                    logger.error(`[FALLBACK] Error con gpt-4o-mini en pagina ${pageNum}: ${fallbackErr.message}`);
                    throw fallbackErr;
                }
            }

            return text;
        } catch (err) {
            if (attempt === config.maxRetries) throw err;

            const isRateLimit = err.status === 429;
            const waitTime = isRateLimit ? config.retryDelayMs * attempt : config.retryDelayMs;
            const detail = err.code || err.cause?.code || err.message;
            logger.warn(`Reintento ${attempt}/${config.maxRetries} para pagina ${pageNum}: ${detail} (espera ${waitTime / 1000}s)`);
            await sleep(waitTime);
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ── Normalizacion de codigo identificado ──────────────────────────────

function normalizeIdentifiedCode(raw) {
    if (!raw) return null;
    let cleaned = raw.trim();

    if (cleaned === 'NO_ENCONTRADO' || cleaned.length < 4) return null;
    const lower = cleaned.toLowerCase();
    if (lower.includes('no puedo') || lower.includes('lo siento') || lower.includes('no se encontr')) return null;

    const codeMatch = cleaned.match(/[RrPpKkBbHh12]\s*[-\u2013\u2014.\s]?\s*(\d{5,7})/);
    if (codeMatch) {
        return `R-${codeMatch[1]}`;
    }

    const digitsOnly = cleaned.match(/(\d{5,7})/);
    if (digitsOnly) {
        return `R-${digitsOnly[1]}`;
    }

    return cleaned;
}

// ── Identificacion rapida de numero de documento (prompt principal) ───

async function identifyDocNumber(pngBuffer, pageNum) {
    const imgBase64 = pngBuffer.toString('base64');

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const messages = [
                {
                    role: 'system',
                    content: PROMPTS.idDocSystem
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: PROMPTS.idDocUser
                        },
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

            // Manejar rechazos del modelo
            const textLower = result.toLowerCase();
            const isRefusal = result.length < 200 && (textLower.includes('no puedo') || textLower.includes('lo siento'));

            if (isRefusal) {
                logger.warn(`[ID REFUSAL] Modelo ${config.model} se nego en pagina ${pageNum}. Reintentando con gpt-4o-mini...`);
                try {
                    const fallbackResponse = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: messages,
                        max_tokens: 50,
                        temperature: 0.0
                    });
                    result = fallbackResponse.choices[0].message.content.trim();
                    logger.info(`[ID FALLBACK] Pagina ${pageNum} identificada con gpt-4o-mini`);
                } catch (fallbackErr) {
                    logger.error(`[ID FALLBACK] Error con gpt-4o-mini en pagina ${pageNum}: ${fallbackErr.message}`);
                    throw fallbackErr;
                }
            }

            return normalizeIdentifiedCode(result);

        } catch (err) {
            if (attempt === config.maxRetries) {
                logger.error(`[ID] Error identificando numero en pagina ${pageNum}: ${err.message}`);
                return null;
            }
            const waitTime = config.retryDelayMs;
            logger.warn(`[ID] Reintento ${attempt}/${config.maxRetries} identificacion pagina ${pageNum}: ${err.message}`);
            await sleep(waitTime);
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ── Segundo intento: prompt minimalista enfocado en digitos ───────────

async function identifyDocNumberRetry(pngBuffer, pageNum) {
    const imgBase64 = pngBuffer.toString('base64');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await openai.chat.completions.create({
            model: config.model,
            messages: [
                {
                    role: 'system',
                    content: PROMPTS.idDocRetrySystem
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: PROMPTS.idDocRetryUser },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                    ]
                }
            ],
            max_tokens: 50,
            temperature: 0.0
        }, { signal: controller.signal });

        const result = response.choices[0].message.content.trim();
        return normalizeIdentifiedCode(result);

    } catch (err) {
        logger.warn(`[ID RETRY] Error en segundo intento pagina ${pageNum}: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// ── Fallback: buscar codigo con Tesseract + regex ─────────────────────

async function identifyWithTesseractFallback(pngBuffer, pageNum) {
    try {
        const tesseractText = await ocrWithTesseract(pngBuffer, pageNum);
        if (!tesseractText) return null;

        const cleaned = normalizeOCR(tesseractText);

        const patterns = [
            /R-(\d{5,7})/gi,
            /[12]\s*[-.]?\s*(\d{5,7})/g,
            /[PpKkBbHh]\s*[-.]?\s*(\d{5,7})/g,
            /(?:^|\s|[-])\s*(\d{6,7})(?:\s|$|[^\d])/gm,
        ];

        for (const pattern of patterns) {
            const match = pattern.exec(cleaned);
            if (match) {
                const digits = match[1];
                logger.info(`  [TESS-FALLBACK] Patron encontrado en texto Tesseract: R-${digits}`);
                return `R-${digits}`;
            }
        }

        return null;
    } catch (err) {
        logger.warn(`  [TESS-FALLBACK] Error en Tesseract fallback pagina ${pageNum}: ${err.message}`);
        return null;
    }
}

// ── Funcion principal exportada ───────────────────────────────────────

/**
 * Procesa un archivo TIFF:
 *  Fase 1: OCR de pagina 1 (caratula) -> extraer documentos_adjuntos
 *  Fase 1b: Pase dedicado para extraer codigos R-XXXXXX directamente de la imagen
 *  Fase 2: Identificacion rapida de numeros en paginas 2+
 *  Fase 3: Fuzzy match + OCR selectivo solo de paginas que coinciden
 *  Fase 4: Reporte de codigos no encontrados
 *
 * @param {string} tiffPath - Ruta absoluta al archivo TIFF
 * @param {string} outputDir - Directorio donde guardar los archivos de salida
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

    // Validar tamano de archivo
    const fileStat = fs.statSync(tiffPath);
    const fileSizeMB = fileStat.size / (1024 * 1024);
    if (fileSizeMB > config.maxFileSizeMB) {
        throw new Error(`Archivo demasiado grande: ${fileSizeMB.toFixed(1)} MB (maximo: ${config.maxFileSizeMB} MB)`);
    }

    // Obtener numero de paginas
    const metadata = await sharp(tiffPath).metadata();
    const numPages = metadata.pages || 1;
    logger.info(`Paginas: ${numPages} | Tamano: ${fileSizeMB.toFixed(1)} MB | Modelo: ${config.model}`);

    // ===================================================================
    // FASE 1: OCR de caratula (puede ser multi-pagina) + extraccion
    // ===================================================================

    logger.info(`[FASE 1] OCR de la caratula con Tesseract (pagina 1)...`);
    const page1Png = await extractPageAsPng(tiffPath, 0, 4096);
    const page1SizeKB = (page1Png.length / 1024).toFixed(1);
    const page1Text = await ocrWithTesseract(page1Png, 1);
    logger.info(`  [PAGE] Pagina 1/${numPages} (${page1SizeKB} KB) - Caratula [Tesseract]`);

    let pagMatch = page1Text.match(/P[a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00e4\u00eb\u00ef\u00f6\u00fc_.:,'"\\-\\|]{1,4}g[^\d]*(\d+)\s*de\s*(\d+)/i) ||
        page1Text.match(/(?:p[\u00e1a]gina|pag|p[\u00e1a]g\.?)\s*(\d+)\s*(?:\/|de)\s*(\d+)/i);

    if (!pagMatch) {
        const endText = page1Text.slice(-1000);
        pagMatch = endText.match(/(?:\n|^)\s*(\d+)\s*de\s*(\d+)\s*(?:\n|$)/i);
    }

    let coverPageCount = 1;
    if (pagMatch) {
        coverPageCount = parseInt(pagMatch[2], 10);
        if (coverPageCount > 1 && coverPageCount <= numPages) {
            logger.info(`[FASE 1] Caratula multi-pagina detectada: ${coverPageCount} paginas`);
        } else {
            coverPageCount = 1;
        }
    }

    const coverPngs = [page1Png];
    const coverTexts = [page1Text];

    for (let ci = 1; ci < coverPageCount && ci < numPages; ci++) {
        const coverPng = await extractPageAsPng(tiffPath, ci, 4096);
        const coverSizeKB = (coverPng.length / 1024).toFixed(1);
        const coverText = await ocrWithTesseract(coverPng, ci + 1);
        coverPngs.push(coverPng);
        coverTexts.push(coverText);
        logger.info(`  [PAGE] Pagina ${ci + 1}/${numPages} (${coverSizeKB} KB) - Caratula (cont.) [Tesseract]`);
    }

    const fullCoverText = coverTexts.join('\n\n');
    const extractedData = await extractFields(fullCoverText);

    const adjuntos = extractedData.documentos_adjuntos || [];

    if (adjuntos.length === 0) {
        logger.warn(`[FASE 1] No se encontraron documentos adjuntos en la caratula. Se omiten paginas restantes.`);
    } else {
        logger.info(`[FASE 1] Documentos adjuntos encontrados: ${adjuntos.length}`);
        for (const adj of adjuntos) {
            logger.info(`  -> ${adj}`);
        }
    }

    // ===================================================================
    // FASE 2 y 3: Identificacion rapida + OCR selectivo (paginas despues de caratula)
    // ===================================================================

    const ubicacion_adjuntos = [];
    const allText = [...coverTexts];
    const matchedCodes = new Set();
    let pendingAdjuntos = [...adjuntos];
    let successCount = coverPageCount;
    let errorCount = 0;
    let skippedCount = 0;

    if (adjuntos.length > 0 && numPages > coverPageCount) {
        logger.info(`[FASE 2] Identificando numeros en paginas ${coverPageCount + 1}-${numPages}...`);

        for (let pageIndex = coverPageCount; pageIndex < numPages; pageIndex++) {
            const pageNum = pageIndex + 1;

            if (pendingAdjuntos.length === 0) {
                logger.info(`  [SKIP] Pagina ${pageNum}/${numPages} - Ya se encontraron todos los codigos (${matchedCodes.size}). Se omite la pagina.`);
                allText.push('');
                skippedCount++;
                continue;
            }

            try {
                const pngBuffer = await extractPageAsPng(tiffPath, pageIndex, 4096);
                const sizeKB = (pngBuffer.length / 1024).toFixed(1);

                // Paso 2A: Identificacion rapida del numero (prompt principal)
                let identifiedNumber = await identifyDocNumber(pngBuffer, pageNum);

                // Paso 2A.1: Si no se encontro, segundo intento con prompt minimalista
                if (!identifiedNumber) {
                    logger.info(`  [RETRY] Pagina ${pageNum}/${numPages} - Segundo intento con prompt alternativo...`);
                    identifiedNumber = await identifyDocNumberRetry(pngBuffer, pageNum);
                }

                // Paso 2A.2: Si aun no se encontro, fallback con Tesseract + regex
                if (!identifiedNumber) {
                    logger.info(`  [RETRY] Pagina ${pageNum}/${numPages} - Fallback con Tesseract + regex...`);
                    identifiedNumber = await identifyWithTesseractFallback(pngBuffer, pageNum);
                }

                // Paso 2A.3: Si aun no se encontro, intento con imagen mejorada (enhanced + crop)
                if (!identifiedNumber) {
                    logger.info(`  [RETRY] Pagina ${pageNum}/${numPages} - Intento con imagen mejorada (enhanced)...`);
                    try {
                        const enhancedBuffer = await enhanceForHandwriting(pngBuffer);
                        identifiedNumber = await identifyDocNumber(enhancedBuffer, pageNum);

                        if (!identifiedNumber) {
                            logger.info(`  [RETRY] Pagina ${pageNum}/${numPages} - Intento con crop zona ASFI + enhanced...`);
                            const croppedBuffer = await cropTopSection(pngBuffer, 0.40);
                            const enhancedCrop = await enhanceForHandwriting(croppedBuffer);
                            identifiedNumber = await identifyDocNumber(enhancedCrop, pageNum);
                        }

                        if (!identifiedNumber) {
                            const enhancedBuffer2 = await enhanceForHandwriting(pngBuffer);
                            identifiedNumber = await identifyWithTesseractFallback(enhancedBuffer2, pageNum);
                        }
                    } catch (enhanceErr) {
                        logger.warn(`  [ENHANCE] Error en preprocesamiento pagina ${pageNum}: ${enhanceErr.message}`);
                    }
                }

                if (!identifiedNumber) {
                    logger.warn(`  [SKIP] Pagina ${pageNum}/${numPages} (${sizeKB} KB) - No se identifico codigo despues de todos los intentos`);
                    allText.push('');
                    skippedCount++;
                    continue;
                }

                logger.info(`  [ID] Pagina ${pageNum}/${numPages} - Codigo identificado: ${identifiedNumber}`);

                // Paso 2B: Fuzzy match contra la lista de adjuntos PENDIENTES
                const matchResult = matchSingleNumber(identifiedNumber, pendingAdjuntos);

                if (!matchResult.matched) {
                    const isAlreadyFound = matchedCodes.has(identifiedNumber.match(/R-\d{5,7}/)?.[0] || '');
                    if (isAlreadyFound) {
                        logger.warn(`  [SKIP] Pagina ${pageNum}/${numPages} (${sizeKB} KB) - El codigo "${identifiedNumber}" ya fue encontrado antes en otra pagina.`);
                    } else {
                        logger.warn(`  [SKIP] Pagina ${pageNum}/${numPages} (${sizeKB} KB) - Codigo "${identifiedNumber}" no coincide con ningun adjunto pendiente (score: ${matchResult.score})`);
                    }
                    allText.push('');
                    skippedCount++;
                    continue;
                }

                logger.info(`  [MATCH] Pagina ${pageNum} <-> ${matchResult.code} (confianza: ${(matchResult.score * 100).toFixed(0)}%)`);
                matchedCodes.add(matchResult.code);

                pendingAdjuntos = pendingAdjuntos.filter(doc => !doc.includes(matchResult.code));
                logger.info(`  [INFO] Codigo "${matchResult.code}" removido de la lista de busqueda. Faltan ${pendingAdjuntos.length} codigos.`);

                // Paso 3: OCR de esta pagina + la siguiente (adjuntos suelen ser multi-pagina)
                logger.info(`  [OCR] Transcribiendo pagina ${pageNum}/${numPages} (${sizeKB} KB)...`);
                const ocrText = await ocrWithVision(pngBuffer, pageNum);
                allText.push(ocrText);
                successCount++;

                // OCR de la pagina siguiente (si existe y no es la caratula)
                let nextPageText = '';
                const nextPageIndex = pageIndex + 1;
                if (nextPageIndex < numPages) {
                    try {
                        const nextPng = await extractPageAsPng(tiffPath, nextPageIndex, 4096);
                        const nextSizeKB = (nextPng.length / 1024).toFixed(1);
                        logger.info(`  [OCR+1] Transcribiendo pagina siguiente ${nextPageIndex + 1}/${numPages} (${nextSizeKB} KB)...`);
                        nextPageText = await ocrWithVision(nextPng, nextPageIndex + 1);
                    } catch (nextErr) {
                        logger.warn(`  [OCR+1] Error en pagina ${nextPageIndex + 1}: ${nextErr.message}`);
                    }
                }

                // Paso 3B: Extraer datos estructurados del adjunto (pagina actual + siguiente)
                const extractionText = nextPageText
                    ? ocrText + '\n\n' + nextPageText
                    : ocrText;
                logger.info(`  [EXTRACT] Extrayendo datos del adjunto (${extractionText.length} chars, ${nextPageText ? '2 paginas' : '1 pagina'})...`);
                let adjuntoData = await extractAdjuntoFields(extractionText);

                // Paso 3C: Fallback paginas anteriores — si campos criticos estan vacios,
                // el codigo R- puede estar en una pagina interior del adjunto.
                const hasCriticalFields = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);

                if (!hasCriticalFields && pageIndex > coverPageCount) {
                    const maxPrevPages = 2;
                    const startIdx = Math.max(coverPageCount, pageIndex - maxPrevPages);
                    logger.info(`  [FALLBACK] Campos criticos vacios. Buscando en paginas anteriores ${startIdx + 1}-${pageNum}...`);

                    let combinedText = '';
                    for (let prevIdx = startIdx; prevIdx < pageIndex; prevIdx++) {
                        try {
                            const prevPng = await extractPageAsPng(tiffPath, prevIdx, 4096);
                            const prevText = await ocrWithVision(prevPng, prevIdx + 1);
                            combinedText += prevText + '\n\n';
                            logger.info(`  [FALLBACK] Pagina ${prevIdx + 1} transcrita para contexto`);
                        } catch (prevErr) {
                            logger.warn(`  [FALLBACK] Error en pagina ${prevIdx + 1}: ${prevErr.message}`);
                        }
                    }

                    if (combinedText.trim().length > 0) {
                        const fullText = combinedText + extractionText;
                        logger.info(`  [FALLBACK] Re-extrayendo con texto combinado (${fullText.length} chars)...`);
                        adjuntoData = await extractAdjuntoFields(fullText);

                        const nowHasCritical = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);
                        if (nowHasCritical) {
                            logger.success(`  [FALLBACK] Campos criticos recuperados con exito`);
                        } else {
                            logger.warn(`  [FALLBACK] Aun sin campos criticos despues del fallback multi-pagina`);
                        }
                    }
                }

                ubicacion_adjuntos.push({
                    documento: matchResult.documento,
                    id_buscado: matchResult.code,
                    id_encontrado: identifiedNumber,
                    pagina: pageNum,
                    confianza: matchResult.score,
                    ...adjuntoData
                });

            } catch (err) {
                logger.error(`  [ERROR] Pagina ${pageNum}/${numPages}: ${err.message}`);
                allText.push(`[ERROR] Pagina ${pageNum}: ${err.message}`);
                errorCount++;
            }
        }
    }

    // ===================================================================
    // FASE 4: Reporte de codigos no encontrados
    // ===================================================================

    const notFound = adjuntos.filter(adj => {
        const code = extractDocCode(adj);
        return !matchedCodes.has(code);
    });

    if (notFound.length > 0) {
        logger.separator();
        logger.warn(`+======================================================+`);
        logger.warn(`|  REPORTE: CODIGOS NO ENCONTRADOS                     |`);
        logger.warn(`+======================================================+`);
        for (const doc of notFound) {
            const code = extractDocCode(doc);
            logger.warn(`|  x ${code.padEnd(15)} - ${doc}`);
        }
        logger.warn(`+======================================================+`);
        logger.warn(`|  Total no encontrados: ${String(notFound.length).padEnd(3)} de ${adjuntos.length} adjuntos     |`);
        logger.warn(`+======================================================+`);
        logger.separator();
    } else if (adjuntos.length > 0) {
        logger.success(`[OK] Todos los ${adjuntos.length} documentos adjuntos fueron localizados exitosamente.`);
    }

    // ===================================================================
    // Escribir resultados TXT y JSON
    // ===================================================================

    const stream = fs.createWriteStream(outputPath);

    stream.write('='.repeat(60) + '\n');
    stream.write(`OCR con ${config.model} Vision - Extraccion de texto\n`);
    stream.write(`Archivo: ${path.basename(tiffPath)}\n`);
    stream.write(`Fecha: ${now}\n`);
    stream.write(`Total de paginas: ${numPages}\n`);
    stream.write(`Paginas transcritas: ${successCount} | Omitidas: ${skippedCount} | Errores: ${errorCount}\n`);
    stream.write('='.repeat(60) + '\n\n');

    // Paginas de caratula
    for (let ci = 0; ci < coverTexts.length; ci++) {
        stream.write('-'.repeat(60) + '\n');
        stream.write(`PAGINA ${ci + 1} / ${numPages} - CARATULA${coverTexts.length > 1 ? ` (${ci + 1}/${coverTexts.length})` : ''}\n`);
        stream.write('-'.repeat(60) + '\n');
        stream.write(coverTexts[ci] + '\n\n');
    }

    // Paginas transcritas (solo las que tuvieron match)
    for (const ubic of ubicacion_adjuntos) {
        const pageTextIndex = ubic.pagina - 1;
        const pageText = allText[pageTextIndex];
        if (!pageText) continue;

        stream.write('-'.repeat(60) + '\n');
        stream.write(`PAGINA ${ubic.pagina} / ${numPages} - ${ubic.id_buscado} (confianza: ${(ubic.confianza * 100).toFixed(0)}%)\n`);
        stream.write('-'.repeat(60) + '\n');
        stream.write(pageText + '\n\n');
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const elapsedStr = formatTime(elapsed);

    stream.write('='.repeat(60) + '\n');
    stream.write(`Completado en ${elapsedStr}\n`);
    stream.write(`Transcritas: ${successCount} | Omitidas: ${skippedCount} | Errores: ${errorCount}\n`);
    if (notFound.length > 0) {
        stream.write(`\nCODIGOS NO ENCONTRADOS:\n`);
        for (const doc of notFound) {
            stream.write(`  x ${doc}\n`);
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
    logger.success(`Completado: ${path.basename(tiffPath)} (${elapsedStr}) - ${successCount} transcritas, ${skippedCount} omitidas`);

    return { outputPath, jsonPath, numPages, success: successCount, errors: errorCount, skipped: skippedCount, elapsed: elapsedStr, extractedData: jsonOutput };
}
