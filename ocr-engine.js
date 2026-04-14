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
import { sleep, renderPrompt, hasStrongFallback, modelLabel, formatTime } from './utils.js';

// ── Constantes ────────────────────────────────────────────────────────

/** Resolución alta para extracción de página (OCR y carátula) */
const HIGH_RES_WIDTH = 4096;

/** Fracción superior para recortar zona de sello ASFI */
const ASFI_CROP_FRACTION = 0.40;

/** Fracción superior para franja superior estándar */
const TOP_STRIP_FRACTION = 0.36;

/** Regiones de recorte para búsqueda multi-pass de código */
const CROP_REGIONS = {
    topRight: { left: 0.48, top: 0, width: 0.52, height: 0.34 },
    topCenterRight: { left: 0.34, top: 0, width: 0.66, height: 0.36 }
};

/** Timeout para identificación rápida de documento (ms) */
const ID_TIMEOUT_MS = 30000;

/** Timeout para identificación dirigida (ms) */
const ID_EXPECTED_TIMEOUT_MS = 45000;

/** Sigma para sharpening de imagen manuscrita */
const HANDWRITING_SHARPEN_SIGMA = 2;

/** Multiplicador de contraste para mejora de manuscrito */
const HANDWRITING_CONTRAST = 1.5;

/** Longitud máxima de texto para considerar como rechazo del modelo */
const REFUSAL_MAX_LENGTH = 200;

/** Máximo de llamadas API por página antes de abandonar la identificación.
 *  Controla la cascada de reintentos para no desperdiciar créditos. */
const MAX_API_CALLS_PER_PAGE = 10;

/** Máximo de páginas previas a buscar en fallback de campos críticos */
const MAX_PREV_PAGES_FALLBACK = 2;

// ── Cargar prompts desde archivos externos ────────────────────────────

const PROMPTS = {
    ocrVisionSystem: fs.readFileSync(path.resolve('./prompts/ocr_vision_system.txt'), 'utf-8'),
    ocrVisionUser: fs.readFileSync(path.resolve('./prompts/ocr_vision_user.txt'), 'utf-8'),
    ocrVisionFallbackSystem: fs.readFileSync(path.resolve('./prompts/ocr_vision_fallback_system.txt'), 'utf-8'),
    ocrVisionFallbackUser: fs.readFileSync(path.resolve('./prompts/ocr_vision_fallback_user.txt'), 'utf-8'),
    idDocSystem: fs.readFileSync(path.resolve('./prompts/id_doc_system.txt'), 'utf-8'),
    idDocUser: fs.readFileSync(path.resolve('./prompts/id_doc_user.txt'), 'utf-8'),
    idDocExpectedSystem: fs.readFileSync(path.resolve('./prompts/id_doc_expected_system.txt'), 'utf-8'),
    idDocExpectedUser: fs.readFileSync(path.resolve('./prompts/id_doc_expected_user.txt'), 'utf-8'),
    idDocRetrySystem: fs.readFileSync(path.resolve('./prompts/id_doc_retry_system.txt'), 'utf-8'),
    idDocRetryUser: fs.readFileSync(path.resolve('./prompts/id_doc_retry_user.txt'), 'utf-8'),
};

// ── Utilidades internas ───────────────────────────────────────────────

/**
 * Normaliza texto OCR para mejorar la deteccion de patrones regex.
 * Unifica guiones, colapsa espacios y estandariza formato R-.
 * @param {string} text - Texto OCR crudo
 * @returns {string} - Texto normalizado
 */
function normalizeOCR(text = '') {
    return text
        .replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/([Rr])\s*[-_.]\s*/g, 'R-')
        .trim();
}

// ── Extraccion de pagina ──────────────────────────────────────────────

/**
 * Extrae una página del TIFF como buffer PNG, opcionalmente redimensionada.
 * @param {string} tiffPath - Ruta al archivo TIFF
 * @param {number} pageIndex - Índice de página (0-based)
 * @param {number} [maxWidth] - Ancho máximo en px
 * @returns {Promise<Buffer>} - Buffer PNG de la página
 */
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
 * @param {Buffer} pngBuffer - Buffer PNG de entrada
 * @returns {Promise<Buffer>} - Buffer PNG mejorado
 */
async function enhanceForHandwriting(pngBuffer) {
    return sharp(pngBuffer)
        .greyscale()
        .normalize()
        .sharpen({ sigma: HANDWRITING_SHARPEN_SIGMA })
        .linear(HANDWRITING_CONTRAST, 0)
        .png()
        .toBuffer();
}

/**
 * Recorta la seccion superior de la imagen donde tipicamente esta el sello ASFI.
 * @param {Buffer} pngBuffer - Buffer PNG de entrada
 * @param {number} fraction - Fraccion superior a conservar (ej: 0.40 = 40% superior)
 * @returns {Promise<Buffer>} - Buffer PNG recortado
 */
async function cropTopSection(pngBuffer, fraction = ASFI_CROP_FRACTION) {
    const meta = await sharp(pngBuffer).metadata();
    const cropHeight = Math.floor(meta.height * fraction);
    return sharp(pngBuffer)
        .extract({ left: 0, top: 0, width: meta.width, height: cropHeight })
        .png()
        .toBuffer();
}

/**
 * Recorta una región proporcional de la imagen.
 * @param {Buffer} pngBuffer - Buffer PNG de entrada
 * @param {{ left: number, top: number, width: number, height: number }} region - Región proporcional (0-1)
 * @returns {Promise<Buffer>} - Buffer PNG de la región
 */
async function cropRegion(pngBuffer, region) {
    const meta = await sharp(pngBuffer).metadata();
    const left = Math.max(0, Math.floor(meta.width * region.left));
    const top = Math.max(0, Math.floor(meta.height * region.top));
    const width = Math.min(meta.width - left, Math.floor(meta.width * region.width));
    const height = Math.min(meta.height - top, Math.floor(meta.height * region.height));

    return sharp(pngBuffer)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
}

/**
 * Detecta si la respuesta del modelo es un rechazo (frases de negación).
 * @param {string} text - Texto de respuesta del modelo
 * @returns {boolean} - true si es un rechazo
 */
function isModelRefusal(text) {
    if (!text || text.length >= REFUSAL_MAX_LENGTH) return false;
    const lower = text.toLowerCase().trim();
    return lower.includes('no puedo') || lower.includes('lo siento');
}

// ── OCR completo con el modelo configurado ────────────────────────────

/**
 * Realiza OCR de una imagen usando el modelo de vision configurado.
 * Maneja reintentos, timeouts y rechazos del modelo con prompt fallback.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página (para logging)
 * @param {string} [model] - Modelo a usar (default: config.model)
 * @returns {Promise<string>} - Texto transcrito
 */
async function ocrWithVision(pngBuffer, pageNum, model = config.model) {
    const imgBase64 = pngBuffer.toString('base64');

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutPerPageMs);

        try {
            const response = await openai.chat.completions.create({
                model,
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
                max_completion_tokens: 4096
            }, { signal: controller.signal });

            const text = response.choices[0].message.content;

            // Detectar rechazos del modelo
            if (isModelRefusal(text)) {
                logger.warn(`[REFUSAL] Modelo ${model} se nego en pagina ${pageNum}. Reintentando con prompt fallback...`);

                try {
                    const fallbackResponse = await openai.chat.completions.create({
                        model,
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
                        max_completion_tokens: 4096
                    });

                    const fallbackText = fallbackResponse.choices[0].message.content;
                    logger.info(`[FALLBACK] Pagina ${pageNum} transcrita con ${model} correctamente`);
                    return fallbackText;
                } catch (fallbackErr) {
                    logger.error(`[FALLBACK] Error con ${model} en pagina ${pageNum}: ${fallbackErr.message}`);
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

/**
 * Normaliza un código identificado por el modelo.
 * Limpia variantes manuscritas (P-, K-, B-) a R-, detecta rechazos y errores.
 * @param {string} raw - Código crudo del modelo
 * @returns {string|null} - Código normalizado o null si no es válido
 */
function normalizeIdentifiedCode(raw) {
    if (!raw) return null;
    const cleaned = raw.trim();

    if (cleaned === 'NO_ENCONTRADO' || cleaned.length < 4) return null;
    const lower = cleaned.toLowerCase();
    if (lower.includes('no_encontrado') || lower.includes('no puedo') || lower.includes('lo siento') || lower.includes('no se encontr')) return null;

    const codeMatch = cleaned.match(/\b[RrPpKkBbHh]\s*[-\u2013\u2014.\s]?\s*(\d{5,7})\b/);
    if (codeMatch) {
        return `R-${codeMatch[1]}`;
    }

    const digitsOnly = cleaned.match(/\b(\d{5,7})\b/);
    if (digitsOnly) {
        return digitsOnly[1];
    }

    return cleaned;
}

// ── Identificacion rapida de numero de documento (prompt principal) ───

/**
 * Identifica el número de documento R-XXXXXX en una página usando el prompt principal.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string} [model] - Modelo a usar
 * @returns {Promise<string|null>} - Código normalizado o null
 */
async function identifyDocNumber(pngBuffer, pageNum, model = config.model) {
    const imgBase64 = pngBuffer.toString('base64');

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ID_TIMEOUT_MS);

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
                model,
                messages,
                max_completion_tokens: 300
            }, { signal: controller.signal });

            let result = response.choices[0].message.content.trim();

            // Manejar rechazos del modelo
            if (isModelRefusal(result)) {
                logger.warn(`[ID REFUSAL] Modelo ${model} se nego en pagina ${pageNum}. Reintentando con prompt fallback...`);
                try {
                    const fallbackResponse = await openai.chat.completions.create({
                        model,
                        messages,
                        max_completion_tokens: 300
                    });
                    result = fallbackResponse.choices[0].message.content.trim();
                    logger.info(`[ID FALLBACK] Pagina ${pageNum} identificada con ${model}`);
                } catch (fallbackErr) {
                    logger.error(`[ID FALLBACK] Error con ${model} en pagina ${pageNum}: ${fallbackErr.message}`);
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

    return null;
}

// ── Segundo intento: prompt minimalista enfocado en digitos ───────────

/**
 * Segundo intento de identificación con prompt minimalista.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string} [model] - Modelo a usar
 * @returns {Promise<string|null>} - Código normalizado o null
 */
async function identifyDocNumberRetry(pngBuffer, pageNum, model = config.model) {
    const imgBase64 = pngBuffer.toString('base64');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ID_TIMEOUT_MS);

    try {
        const response = await openai.chat.completions.create({
            model,
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
            max_completion_tokens: 300
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

// ── Identificacion dirigida contra codigos pendientes ─────────────────

/**
 * Identificación dirigida: le muestra al modelo los códigos esperados.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string[]} documentList - Lista de documentos adjuntos pendientes
 * @param {string} [model] - Modelo a usar
 * @returns {Promise<string|null>} - Código normalizado o null
 */
async function identifyExpectedDocNumber(pngBuffer, pageNum, documentList, model = config.model) {
    const expectedCodes = [...new Set(documentList.map(extractDocCode).filter(Boolean))];
    if (expectedCodes.length === 0) return null;

    const imgBase64 = pngBuffer.toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ID_EXPECTED_TIMEOUT_MS);

    try {
        const response = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: 'system',
                    content: PROMPTS.idDocExpectedSystem
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: renderPrompt(PROMPTS.idDocExpectedUser, {
                                pageNum,
                                codes: expectedCodes.map(code => `- ${code}`).join('\n')
                            })
                        },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                    ]
                }
            ],
            max_completion_tokens: 300
        }, { signal: controller.signal });

        const result = response.choices[0].message.content.trim();
        const normalized = normalizeIdentifiedCode(result);
        if (!normalized) return null;

        if (expectedCodes.includes(normalized)) {
            return normalized;
        }

        const match = matchSingleNumber(normalized, documentList);
        if (match.matched) {
            return match.code;
        }

        logger.warn(`  [ID TARGET] Pagina ${pageNum}: respuesta "${normalized}" no esta en codigos pendientes`);
        return null;
    } catch (err) {
        logger.warn(`  [ID TARGET] Error en identificacion dirigida pagina ${pageNum} con ${model}: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Búsqueda multi-pass: prueba múltiples vistas de la página para encontrar el código.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string[]} documentList - Lista de documentos adjuntos pendientes
 * @param {string} [model] - Modelo a usar
 * @returns {Promise<string|null>} - Código encontrado o null
 */
async function identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, documentList, model = config.model) {
    const views = [
        { label: 'pagina completa', create: async () => pngBuffer },
        { label: 'franja superior', create: async () => cropTopSection(pngBuffer, TOP_STRIP_FRACTION) },
        {
            label: 'zona superior derecha',
            create: async () => cropRegion(pngBuffer, CROP_REGIONS.topRight)
        },
        {
            label: 'zona superior central-derecha',
            create: async () => cropRegion(pngBuffer, CROP_REGIONS.topCenterRight)
        }
    ];

    for (const view of views) {
        try {
            const viewBuffer = await view.create();
            const found = await identifyExpectedDocNumber(viewBuffer, pageNum, documentList, model);
            if (found) {
                logger.info(`  [ID TARGET] Pagina ${pageNum}: ${found} detectado en ${view.label} con ${model}`);
                return found;
            }
        } catch (err) {
            logger.warn(`  [ID TARGET] Error procesando ${view.label} pagina ${pageNum}: ${err.message}`);
        }
    }

    try {
        const top = await cropTopSection(pngBuffer, TOP_STRIP_FRACTION);
        const enhancedTop = await enhanceForHandwriting(top);
        const found = await identifyExpectedDocNumber(enhancedTop, pageNum, documentList, model);
        if (found) {
            logger.info(`  [ID TARGET] Pagina ${pageNum}: ${found} detectado en franja superior mejorada con ${model}`);
            return found;
        }
    } catch (err) {
        logger.warn(`  [ID TARGET] Error en franja superior mejorada pagina ${pageNum}: ${err.message}`);
    }

    return null;
}

// ── Fallback: buscar codigo con Tesseract + regex ─────────────────────

/**
 * Identifica códigos de documento usando Tesseract local + regex.
 * Actúa como fallback cuando el modelo de visión no encuentra el código.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string[]} [documentList] - Lista de documentos para validación cruzada
 * @returns {Promise<string|null>} - Código encontrado o null
 */
async function identifyWithTesseractFallback(pngBuffer, pageNum, documentList = []) {
    try {
        const tesseractText = await ocrWithTesseract(pngBuffer, pageNum);
        if (!tesseractText) return null;

        const cleaned = normalizeOCR(tesseractText);

        const patterns = [
            { regex: /\bR-(\d{5,7})\b/gi, prefixed: true },
            { regex: /\b[PpKkBbHh]\s*[-.]?\s*(\d{5,7})\b/g, prefixed: true },
            { regex: /(?:^|\s|[-])\s*(\d{6,7})(?:\s|$|[^\d])/gm, prefixed: false },
        ];

        const candidates = [];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.regex.exec(cleaned)) !== null) {
                const digits = match[1];
                const code = pattern.prefixed ? `R-${digits}` : digits;
                candidates.push(code);
            }
        }

        const uniqueCandidates = [...new Set(candidates)];
        if (uniqueCandidates.length === 0) return null;

        if (documentList.length > 0) {
            for (const candidate of uniqueCandidates) {
                const result = matchSingleNumber(candidate, documentList);
                if (result.matched) {
                    logger.info(`  [TESS-FALLBACK] Candidato validado contra pendientes: ${candidate} -> ${result.code}`);
                    return candidate;
                }
            }
        }

        logger.info(`  [TESS-FALLBACK] Patron encontrado en texto Tesseract: ${uniqueCandidates[0]}`);
        return uniqueCandidates[0];
    } catch (err) {
        logger.warn(`  [TESS-FALLBACK] Error en Tesseract fallback pagina ${pageNum}: ${err.message}`);
        return null;
    }
}

// ── Identificación escalonada con presupuesto de llamadas API ─────────

/**
 * Orquesta la cascada de identificación de código en una página,
 * respetando un presupuesto máximo de llamadas API.
 *
 * Orden de intentos:
 *   1. identifyDocNumber (prompt principal)
 *   2. identifyDocNumberRetry (prompt minimalista)
 *   3. Tesseract + regex (sin API)
 *   4. Imagen mejorada + identifyDocNumber
 *   5. Crop ASFI + enhanced + identifyDocNumber
 *   6. Tesseract + enhanced (sin API)
 *   7. identifyExpectedDocNumberMultiPass (búsqueda dirigida)
 *   8. Modelo fuerte (si disponible y queda presupuesto)
 *
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string[]} pendingAdjuntos - Lista de adjuntos pendientes
 * @returns {Promise<string|null>} - Código identificado o null
 */
async function identifyPageCode(pngBuffer, pageNum, pendingAdjuntos) {
    let apiCalls = 0;
    const budget = MAX_API_CALLS_PER_PAGE;

    /** Ejecuta fn solo si queda presupuesto. Incrementa el contador. */
    async function withBudget(fn, label) {
        if (apiCalls >= budget) {
            logger.debug(`  [BUDGET] Pagina ${pageNum}: presupuesto agotado (${apiCalls}/${budget}), omitiendo ${label}`);
            return null;
        }
        apiCalls++;
        return fn();
    }

    // Paso 1: Prompt principal
    let result = await withBudget(
        () => identifyDocNumber(pngBuffer, pageNum),
        'identifyDocNumber'
    );
    if (result) return result;

    // Paso 2: Prompt minimalista
    logger.info(`  [RETRY] Pagina ${pageNum} - Segundo intento con prompt alternativo...`);
    result = await withBudget(
        () => identifyDocNumberRetry(pngBuffer, pageNum),
        'identifyDocNumberRetry'
    );
    if (result) return result;

    // Paso 3: Tesseract + regex (no consume API)
    logger.info(`  [RETRY] Pagina ${pageNum} - Fallback con Tesseract + regex...`);
    result = await identifyWithTesseractFallback(pngBuffer, pageNum, pendingAdjuntos);
    if (result) return result;

    // Paso 4: Imagen mejorada + identificación
    logger.info(`  [RETRY] Pagina ${pageNum} - Intento con imagen mejorada (enhanced)...`);
    try {
        const enhancedBuffer = await enhanceForHandwriting(pngBuffer);
        result = await withBudget(
            () => identifyDocNumber(enhancedBuffer, pageNum),
            'identifyDocNumber(enhanced)'
        );
        if (result) return result;

        // Paso 5: Crop ASFI + enhanced
        if (apiCalls < budget) {
            logger.info(`  [RETRY] Pagina ${pageNum} - Intento con crop zona ASFI + enhanced...`);
            const croppedBuffer = await cropTopSection(pngBuffer, ASFI_CROP_FRACTION);
            const enhancedCrop = await enhanceForHandwriting(croppedBuffer);
            result = await withBudget(
                () => identifyDocNumber(enhancedCrop, pageNum),
                'identifyDocNumber(crop+enhanced)'
            );
            if (result) return result;
        }

        // Paso 6: Tesseract + enhanced (no consume API)
        const enhancedBuffer2 = await enhanceForHandwriting(pngBuffer);
        result = await identifyWithTesseractFallback(enhancedBuffer2, pageNum, pendingAdjuntos);
        if (result) return result;
    } catch (enhanceErr) {
        logger.warn(`  [ENHANCE] Error en preprocesamiento pagina ${pageNum}: ${enhanceErr.message}`);
    }

    // Paso 7: Búsqueda dirigida con códigos pendientes
    if (apiCalls < budget) {
        logger.info(`  [RETRY] Pagina ${pageNum} - Busqueda dirigida con codigos pendientes...`);
        result = await identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, pendingAdjuntos);
        apiCalls += 5; // multipass consume ~5 llamadas
        if (result) return result;

        if (hasStrongFallback() && apiCalls < budget) {
            logger.info(`  [RETRY] Pagina ${pageNum} - Busqueda dirigida con modelo fuerte ${config.strongModel}...`);
            result = await identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, pendingAdjuntos, config.strongModel);
            apiCalls += 5;
            if (result) return result;
        }
    }

    // Paso 8: Modelo fuerte como último recurso
    if (hasStrongFallback() && apiCalls < budget) {
        logger.info(`  [RETRY] Pagina ${pageNum} - Reintentando con modelo fuerte ${config.strongModel}...`);

        result = await withBudget(
            () => identifyDocNumber(pngBuffer, pageNum, config.strongModel),
            'identifyDocNumber(strong)'
        );
        if (result) return result;

        result = await withBudget(
            () => identifyDocNumberRetry(pngBuffer, pageNum, config.strongModel),
            'identifyDocNumberRetry(strong)'
        );
        if (result) return result;

        if (apiCalls < budget) {
            try {
                const enhancedBuffer = await enhanceForHandwriting(pngBuffer);
                result = await withBudget(
                    () => identifyDocNumber(enhancedBuffer, pageNum, config.strongModel),
                    'identifyDocNumber(strong+enhanced)'
                );
                if (result) return result;
            } catch (strongEnhanceErr) {
                logger.warn(`  [ENHANCE] Error en reintento fuerte pagina ${pageNum}: ${strongEnhanceErr.message}`);
            }
        }
    }

    logger.debug(`  [BUDGET] Pagina ${pageNum}: total de llamadas API: ${apiCalls}/${budget}`);
    return null;
}

// ── Funcion principal exportada ───────────────────────────────────────

/**
 * Procesa un archivo TIFF completo:
 *
 *  Fase 1: OCR de carátula (puede ser multi-página) → extraer documentos_adjuntos
 *  Fase 2: Identificación escalonada de números en páginas 2+
 *  Fase 3: OCR selectivo + extracción de datos de adjuntos que coinciden
 *  Fase 4: Reporte de códigos no encontrados
 *
 * @param {string} tiffPath - Ruta absoluta al archivo TIFF
 * @param {string} outputDir - Directorio donde guardar los archivos de salida
 * @returns {Promise<{outputPath: string, jsonPath: string, numPages: number, success: number, errors: number, skipped: number, elapsed: string, extractedData: object}>}
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
    logger.info(`Paginas: ${numPages} | Tamano: ${fileSizeMB.toFixed(1)} MB | Modelo: ${modelLabel()}`);

    // ===================================================================
    // FASE 1: OCR de caratula (puede ser multi-pagina) + extraccion
    // ===================================================================

    logger.info('[FASE 1] OCR de la caratula con Tesseract (pagina 1)...');
    const page1Png = await extractPageAsPng(tiffPath, 0, HIGH_RES_WIDTH);
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
        const coverPng = await extractPageAsPng(tiffPath, ci, HIGH_RES_WIDTH);
        const coverSizeKB = (coverPng.length / 1024).toFixed(1);
        const coverText = await ocrWithTesseract(coverPng, ci + 1);
        coverPngs.push(coverPng);
        coverTexts.push(coverText);
        logger.info(`  [PAGE] Pagina ${ci + 1}/${numPages} (${coverSizeKB} KB) - Caratula (cont.) [Tesseract]`);
    }

    const fullCoverText = coverTexts.join('\n\n');
    let extractedData = await extractFields(fullCoverText);

    let adjuntos = extractedData.documentos_adjuntos || [];

    if ((extractedData._error || adjuntos.length === 0) && hasStrongFallback()) {
        logger.warn(`[FASE 1] Extraccion de caratula incompleta con ${config.model}. Reintentando con modelo fuerte ${config.strongModel}...`);
        const strongExtractedData = await extractFields(fullCoverText, { model: config.strongModel });
        const strongAdjuntos = strongExtractedData.documentos_adjuntos || [];

        if (!strongExtractedData._error && (strongAdjuntos.length > 0 || adjuntos.length === 0)) {
            extractedData = strongExtractedData;
            adjuntos = strongAdjuntos;
            logger.info(`[FASE 1] Resultado de caratula actualizado con ${config.strongModel}. Adjuntos: ${adjuntos.length}`);
        }
    }

    if (adjuntos.length === 0) {
        logger.warn('[FASE 1] No se encontraron documentos adjuntos en la caratula. Se omiten paginas restantes.');
    } else {
        logger.info(`[FASE 1] Documentos adjuntos encontrados: ${adjuntos.length}`);
        for (const adj of adjuntos) {
            logger.info(`  -> ${adj}`);
        }
    }

    // ===================================================================
    // FASE 2 y 3: Identificacion + OCR selectivo (paginas despues de caratula)
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
                const pngBuffer = await extractPageAsPng(tiffPath, pageIndex, HIGH_RES_WIDTH);
                const sizeKB = (pngBuffer.length / 1024).toFixed(1);

                // Identificación escalonada con presupuesto
                let identifiedNumber = await identifyPageCode(pngBuffer, pageNum, pendingAdjuntos);

                // Fuzzy match contra la lista de adjuntos PENDIENTES
                let matchResult = matchSingleNumber(identifiedNumber, pendingAdjuntos);

                // Si el código fue encontrado pero no coincide, intento dirigido
                if (identifiedNumber && !matchResult.matched) {
                    logger.info(`  [RETRY] Pagina ${pageNum}/${numPages} - Codigo "${identifiedNumber}" no coincide. Reintentando contra lista pendiente...`);
                    let targetedNumber = await identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, pendingAdjuntos);
                    if (!targetedNumber && hasStrongFallback()) {
                        targetedNumber = await identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, pendingAdjuntos, config.strongModel);
                    }
                    if (targetedNumber) {
                        const targetedMatch = matchSingleNumber(targetedNumber, pendingAdjuntos);
                        if (targetedMatch.matched) {
                            identifiedNumber = targetedNumber;
                            matchResult = targetedMatch;
                            logger.info(`  [ID TARGET] Pagina ${pageNum}/${numPages} - Codigo corregido: ${identifiedNumber}`);
                        }
                    }
                }

                if (!identifiedNumber) {
                    logger.warn(`  [SKIP] Pagina ${pageNum}/${numPages} (${sizeKB} KB) - No se identifico codigo despues de todos los intentos`);
                    allText.push('');
                    skippedCount++;
                    continue;
                }

                logger.info(`  [ID] Pagina ${pageNum}/${numPages} - Codigo identificado: ${identifiedNumber}`);

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

                pendingAdjuntos = pendingAdjuntos.filter(doc => extractDocCode(doc) !== matchResult.code);
                logger.info(`  [INFO] Codigo "${matchResult.code}" removido de la lista de busqueda. Faltan ${pendingAdjuntos.length} codigos.`);

                // Paso 3: OCR de esta pagina
                logger.info(`  [OCR] Transcribiendo pagina ${pageNum}/${numPages} (${sizeKB} KB)...`);
                const ocrText = (await ocrWithVision(pngBuffer, pageNum)) || '';
                allText.push(ocrText);
                successCount++;

                // Paso 3B: Intentar extracción con solo la página actual primero
                let extractionText = ocrText;
                logger.info(`  [EXTRACT] Extrayendo datos del adjunto (${extractionText.length} chars, 1 pagina)...`);
                let adjuntoData = await extractAdjuntoFields(extractionText);

                let hasCriticalFields = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);

                // Paso 3C: Si faltan campos críticos, intentar con la página siguiente (OCR+1)
                const nextPageIndex = pageIndex + 1;
                if (!hasCriticalFields && nextPageIndex < numPages) {
                    try {
                        const nextPng = await extractPageAsPng(tiffPath, nextPageIndex, HIGH_RES_WIDTH);
                        const nextSizeKB = (nextPng.length / 1024).toFixed(1);
                        logger.info(`  [OCR+1] Campos criticos vacios. Transcribiendo pagina siguiente ${nextPageIndex + 1}/${numPages} (${nextSizeKB} KB)...`);
                        const nextPageText = (await ocrWithVision(nextPng, nextPageIndex + 1)) || '';

                        if (nextPageText.trim().length > 0) {
                            extractionText = ocrText + '\n\n' + nextPageText;
                            logger.info(`  [EXTRACT] Re-extrayendo con 2 paginas (${extractionText.length} chars)...`);
                            adjuntoData = await extractAdjuntoFields(extractionText);
                            hasCriticalFields = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);
                        }
                    } catch (nextErr) {
                        logger.warn(`  [OCR+1] Error en pagina ${nextPageIndex + 1}: ${nextErr.message}`);
                    }
                }

                // Paso 3D: Fallback modelo fuerte si aún faltan campos
                if (!hasCriticalFields && hasStrongFallback()) {
                    logger.info(`  [EXTRACT] Campos criticos vacios. Reintentando adjunto con modelo fuerte ${config.strongModel}...`);
                    adjuntoData = await extractAdjuntoFields(extractionText, { model: config.strongModel });
                    hasCriticalFields = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);
                }

                // Paso 3E: Fallback paginas anteriores — primero con Tesseract (rápido),
                // luego con Vision solo si Tesseract no es suficiente.
                if (!hasCriticalFields && pageIndex > coverPageCount) {
                    const startIdx = Math.max(coverPageCount, pageIndex - MAX_PREV_PAGES_FALLBACK);
                    logger.info(`  [FALLBACK] Campos criticos vacios. Buscando en paginas anteriores ${startIdx + 1}-${pageNum} con Tesseract...`);

                    // Intentar primero con Tesseract (rápido, sin costo API)
                    let combinedText = '';
                    for (let prevIdx = startIdx; prevIdx < pageIndex; prevIdx++) {
                        try {
                            const prevPng = await extractPageAsPng(tiffPath, prevIdx, HIGH_RES_WIDTH);
                            const prevText = await ocrWithTesseract(prevPng, prevIdx + 1);
                            if (prevText) {
                                combinedText += prevText + '\n\n';
                                logger.info(`  [FALLBACK] Pagina ${prevIdx + 1} transcrita con Tesseract para contexto`);
                            }
                        } catch (prevErr) {
                            logger.warn(`  [FALLBACK] Error Tesseract en pagina ${prevIdx + 1}: ${prevErr.message}`);
                        }
                    }

                    if (combinedText.trim().length > 0) {
                        const fullText = combinedText + extractionText;
                        logger.info(`  [FALLBACK] Re-extrayendo con texto combinado Tesseract (${fullText.length} chars)...`);
                        adjuntoData = await extractAdjuntoFields(fullText);
                        hasCriticalFields = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);
                    }

                    // Solo usar Vision API si Tesseract no fue suficiente
                    if (!hasCriticalFields) {
                        logger.info('  [FALLBACK] Tesseract insuficiente. Reintentando con Vision API...');
                        combinedText = '';
                        for (let prevIdx = startIdx; prevIdx < pageIndex; prevIdx++) {
                            try {
                                const prevPng = await extractPageAsPng(tiffPath, prevIdx, HIGH_RES_WIDTH);
                                const prevText = (await ocrWithVision(prevPng, prevIdx + 1)) || '';
                                combinedText += prevText + '\n\n';
                                logger.info(`  [FALLBACK] Pagina ${prevIdx + 1} transcrita con Vision para contexto`);
                            } catch (prevErr) {
                                logger.warn(`  [FALLBACK] Error Vision en pagina ${prevIdx + 1}: ${prevErr.message}`);
                            }
                        }

                        if (combinedText.trim().length > 0) {
                            const fullText = combinedText + extractionText;
                            logger.info(`  [FALLBACK] Re-extrayendo con texto combinado Vision (${fullText.length} chars)...`);
                            adjuntoData = await extractAdjuntoFields(fullText);

                            const nowHasCritical = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);
                            if (nowHasCritical) {
                                logger.success('  [FALLBACK] Campos criticos recuperados con exito');
                            } else {
                                logger.warn('  [FALLBACK] Aun sin campos criticos despues del fallback multi-pagina');
                            }
                        }
                    } else {
                        logger.success('  [FALLBACK] Campos criticos recuperados con Tesseract');
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
        logger.warn('+======================================================+');
        logger.warn('|  REPORTE: CODIGOS NO ENCONTRADOS                     |');
        logger.warn('+======================================================+');
        for (const doc of notFound) {
            const code = extractDocCode(doc) || 'SIN_CODIGO';
            logger.warn(`|  x ${code.padEnd(15)} - ${doc}`);
        }
        logger.warn('+======================================================+');
        logger.warn(`|  Total no encontrados: ${String(notFound.length).padEnd(3)} de ${adjuntos.length} adjuntos     |`);
        logger.warn('+======================================================+');
        logger.separator();
    } else if (adjuntos.length > 0) {
        logger.success(`[OK] Todos los ${adjuntos.length} documentos adjuntos fueron localizados exitosamente.`);
    }

    // ===================================================================
    // Escribir resultados TXT y JSON
    // ===================================================================

    const stream = fs.createWriteStream(outputPath);

    // Manejar errores del stream de escritura
    stream.on('error', (err) => {
        logger.error(`[OUTPUT] Error escribiendo archivo de salida: ${err.message}`);
    });

    stream.write('='.repeat(60) + '\n');
    stream.write(`OCR con ${modelLabel()} Vision - Extraccion de texto\n`);
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
        stream.write('\nCODIGOS NO ENCONTRADOS:\n');
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
        codigos_no_encontrados: notFound.length > 0 ? notFound.map(d => extractDocCode(d) || 'SIN_CODIGO') : undefined
    };

    fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');
    logger.success(`[JSON] JSON guardado: ${path.basename(jsonPath)}`);
    logger.success(`Completado: ${path.basename(tiffPath)} (${elapsedStr}) - ${successCount} transcritas, ${skippedCount} omitidas`);

    return { outputPath, jsonPath, numPages, success: successCount, errors: errorCount, skipped: skippedCount, elapsed: elapsedStr, extractedData: jsonOutput };
}
