import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import { extractFields } from './extractor.js';
import { extractAdjuntoFields, normalizeJuezValue } from './adjunto-extractor.js';
import {
    matchSingleNumber,
    extractDocCode,
    matchPageWithDocumentsByContext,
    extractDocDateKey,
    extractPageDateKeys
} from './fuzzy-match.js';
import { sleep, renderPrompt, modelLabel, formatTime } from './utils.js';

// ── Constantes ────────────────────────────────────────────────────────

/** Resolucion alta para extraccion de paginas con Vision */
const HIGH_RES_WIDTH = 4096;

/** Fracción superior para recortar zona de sello ASFI */
const ASFI_CROP_FRACTION = 0.40;

/** Fracción superior para franja superior estándar */
const TOP_STRIP_FRACTION = 0.36;

/** Regiones de recorte para búsqueda exhaustiva de código */
const CROP_REGIONS = {
    topLeft: { left: 0, top: 0, width: 0.55, height: 0.42 },
    topCenter: { left: 0.22, top: 0, width: 0.56, height: 0.42 },
    topRight: { left: 0.45, top: 0, width: 0.55, height: 0.42 },
    middleLeft: { left: 0, top: 0.24, width: 0.55, height: 0.42 },
    middleCenter: { left: 0.22, top: 0.24, width: 0.56, height: 0.42 },
    middleRight: { left: 0.45, top: 0.24, width: 0.55, height: 0.42 },
    bottomLeft: { left: 0, top: 0.58, width: 0.55, height: 0.42 },
    bottomCenter: { left: 0.22, top: 0.58, width: 0.56, height: 0.42 },
    bottomRight: { left: 0.45, top: 0.58, width: 0.55, height: 0.42 },
    leftHalf: { left: 0, top: 0, width: 0.54, height: 1 },
    rightHalf: { left: 0.46, top: 0, width: 0.54, height: 1 },
    upperHalf: { left: 0, top: 0, width: 1, height: 0.54 },
    lowerHalf: { left: 0, top: 0.46, width: 1, height: 0.54 },
    centerBand: { left: 0.15, top: 0.15, width: 0.70, height: 0.70 }
};

/** Recortes focalizados para recuperar el nombre del juez en el bloque de firma */
const JUDGE_SIGNATURE_REGIONS = [
    { label: 'franja inferior', region: { left: 0, top: 0.68, width: 1, height: 0.32 } },
    { label: 'bloque inferior derecho', region: { left: 0.42, top: 0.56, width: 0.58, height: 0.44 } }
];

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

/** Máximo de llamadas API por página antes de abandonar la identificación. */
const MAX_API_CALLS_PER_PAGE = 8;

/** Máximo de páginas previas a buscar en fallback de campos críticos */
const MAX_PREV_PAGES_FALLBACK = 2;

// ── Cargar prompts desde archivos externos ────────────────────────────

const PROMPTS = {
    ocrVisionSystem: fs.readFileSync(path.resolve('./prompts/ocr_vision_system.txt'), 'utf-8'),
    ocrVisionUser: fs.readFileSync(path.resolve('./prompts/ocr_vision_user.txt'), 'utf-8'),
    ocrVisionFallbackSystem: fs.readFileSync(path.resolve('./prompts/ocr_vision_fallback_system.txt'), 'utf-8'),
    ocrVisionFallbackUser: fs.readFileSync(path.resolve('./prompts/ocr_vision_fallback_user.txt'), 'utf-8'),
    extractJuezSystem: fs.readFileSync(path.resolve('./prompts/extract_juez_system.txt'), 'utf-8'),
    extractJuezUser: fs.readFileSync(path.resolve('./prompts/extract_juez_user.txt'), 'utf-8'),
    idDocSystem: fs.readFileSync(path.resolve('./prompts/id_doc_system.txt'), 'utf-8'),
    idDocUser: fs.readFileSync(path.resolve('./prompts/id_doc_user.txt'), 'utf-8'),
    idDocExpectedSystem: fs.readFileSync(path.resolve('./prompts/id_doc_expected_system.txt'), 'utf-8'),
    idDocExpectedUser: fs.readFileSync(path.resolve('./prompts/id_doc_expected_user.txt'), 'utf-8'),
    idDocRetrySystem: fs.readFileSync(path.resolve('./prompts/id_doc_retry_system.txt'), 'utf-8'),
    idDocRetryUser: fs.readFileSync(path.resolve('./prompts/id_doc_retry_user.txt'), 'utf-8'),
};

// ── Utilidades internas ───────────────────────────────────────────────

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

/**
 * Detecta adjuntos que parecen venir de transcripcion pegada o dudosa, por ejemplo
 * "R-251991DE30DE OCTUBRE" sin separador entre el codigo y la fecha.
 * @param {string} adjunto - Texto del adjunto
 * @returns {boolean}
 */
function isSuspiciousAdjunto(adjunto = '') {
    return /\bR\s*[-.]?\s*\d{5,7}DE\s*\d{1,2}\s*DE\b/i.test(adjunto);
}

/**
 * Cuenta adjuntos con formato sospechoso.
 * @param {string[]} adjuntos - Lista de adjuntos
 * @returns {number}
 */
function countSuspiciousAdjuntos(adjuntos = []) {
    return adjuntos.filter(isSuspiciousAdjunto).length;
}

/**
 * Revalida el match de una página usando la transcripción OCR completa.
 * Corrige falsos positivos del modo "lista esperada" si el OCR de la página
 * sugiere otro código pendiente con mejor soporte visual.
 * @param {{ matched: boolean, documento: string|null, code: string|null, score: number }} matchResult
 * @param {string} visionText
 * @param {string[]} pendingAdjuntos
 * @returns {{ matched: boolean, documento: string|null, code: string|null, score: number }}
 */
function reconcileMatchWithVisionText(matchResult, visionText, pendingAdjuntos) {
    if (!visionText || !pendingAdjuntos || pendingAdjuntos.length === 0) {
        return matchResult;
    }

    const contextMatch = matchPageWithDocumentsByContext(visionText, pendingAdjuntos);
    if (!contextMatch.matched) {
        return matchResult;
    }

    if (!matchResult.matched) {
        return contextMatch;
    }

    if (contextMatch.code === matchResult.code) {
        return matchResult;
    }

    const pageDates = new Set(extractPageDateKeys(visionText));
    const currentDate = extractDocDateKey(matchResult.documento);
    const contextDate = extractDocDateKey(contextMatch.documento);
    const currentDateMatches = currentDate ? pageDates.has(currentDate) : false;
    const contextDateMatches = contextDate ? pageDates.has(contextDate) : false;

    if (contextDateMatches && !currentDateMatches) {
        return contextMatch;
    }

    if (contextDateMatches === currentDateMatches && contextMatch.score > matchResult.score) {
        return contextMatch;
    }

    return matchResult;
}

// ── Transcripcion completa con Vision ─────────────────────────────────

/**
 * Transcribe una imagen usando el modelo Vision configurado.
 * Maneja reintentos, timeouts y rechazos del modelo con prompt fallback.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página (para logging)
 * @returns {Promise<string>} - Texto transcrito
 */
async function transcribeWithVision(pngBuffer, pageNum) {
    const model = config.model;
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

async function extractJudgeFromCrop(pngBuffer, pageNum, label) {
    const model = config.model;
    const imgBase64 = pngBuffer.toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutPerPageMs);

    try {
        const response = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: 'system',
                    content: PROMPTS.extractJuezSystem
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: renderPrompt(PROMPTS.extractJuezUser, { pageNum, label })
                        },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: 'high' } }
                    ]
                }
            ],
            max_completion_tokens: 300
        }, { signal: controller.signal });

        const raw = response.choices[0].message.content.trim();
        const normalized = normalizeJuezValue(raw);
        if (normalized) {
            logger.info(`  [JUEZ] Pagina ${pageNum} - Nombre recuperado desde ${label}: ${normalized}`);
            return normalized;
        }

        return '';
    } catch (err) {
        logger.warn(`  [JUEZ] Error recuperando juez en pagina ${pageNum} (${label}): ${err.message}`);
        return '';
    } finally {
        clearTimeout(timeout);
    }
}

async function recoverMissingJudge(pngBuffer, pageNum) {
    for (const { label, region } of JUDGE_SIGNATURE_REGIONS) {
        logger.info(`  [JUEZ] Pagina ${pageNum} - Intento focalizado en ${label}...`);
        const cropped = await cropRegion(pngBuffer, region);
        const directJudge = await extractJudgeFromCrop(cropped, pageNum, label);
        if (directJudge) return directJudge;

        logger.info(`  [JUEZ] Pagina ${pageNum} - Intento ${label} + enhanced...`);
        const enhanced = await enhanceForHandwriting(cropped);
        const enhancedJudge = await extractJudgeFromCrop(enhanced, pageNum, `${label} + enhanced`);
        if (enhancedJudge) return enhancedJudge;
    }

    return '';
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

    const codeMatch = cleaned.match(/\b[RrPpKkBbHh]\s*[-\u2013\u2014.\s]?\s*((?:\d\s*){5,7})\b/);
    if (codeMatch) {
        return `R-${codeMatch[1].replace(/\s+/g, '')}`;
    }

    const digitsOnly = cleaned.match(/\b(\d{5,7})\b/);
    if (digitsOnly) {
        return digitsOnly[1];
    }

    const spacedDigitsOnly = cleaned.match(/\b((?:\d\s*){5,7})\b/);
    if (spacedDigitsOnly) {
        return spacedDigitsOnly[1].replace(/\s+/g, '');
    }

    return cleaned;
}

// ── Identificacion rapida de numero de documento (prompt principal) ───

/**
 * Identifica el número de documento R-XXXXXX en una página usando el prompt principal.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @returns {Promise<string|null>} - Código normalizado o null
 */
async function identifyDocNumber(pngBuffer, pageNum) {
    const model = config.model;
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
 * @returns {Promise<string|null>} - Código normalizado o null
 */
async function identifyDocNumberRetry(pngBuffer, pageNum) {
    const model = config.model;
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
 * @returns {Promise<string|null>} - Código normalizado o null
 */
async function identifyExpectedDocNumber(pngBuffer, pageNum, documentList) {
    const model = config.model;
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
 * Búsqueda exhaustiva: prueba múltiples vistas solapadas de la página para encontrar el código.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string[]} documentList - Lista de documentos adjuntos pendientes
 * @returns {Promise<string|null>} - Código encontrado o null
 */
async function identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, documentList) {
    const model = config.model;
    const views = [
        { label: 'pagina completa', create: async () => pngBuffer },
        { label: 'franja superior', create: async () => cropTopSection(pngBuffer, TOP_STRIP_FRACTION) },
        { label: 'mitad superior', create: async () => cropRegion(pngBuffer, CROP_REGIONS.upperHalf) },
        { label: 'mitad inferior', create: async () => cropRegion(pngBuffer, CROP_REGIONS.lowerHalf) },
        { label: 'zona superior derecha', create: async () => cropRegion(pngBuffer, CROP_REGIONS.topRight) },
        { label: 'zona superior izquierda', create: async () => cropRegion(pngBuffer, CROP_REGIONS.topLeft) }
    ];

    for (const view of views) {
        try {
            const viewBuffer = await view.create();
            const found = await identifyExpectedDocNumber(viewBuffer, pageNum, documentList);
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
        const found = await identifyExpectedDocNumber(enhancedTop, pageNum, documentList);
        if (found) {
            logger.info(`  [ID TARGET] Pagina ${pageNum}: ${found} detectado en franja superior mejorada con ${model}`);
            return found;
        }
    } catch (err) {
        logger.warn(`  [ID TARGET] Error en franja superior mejorada pagina ${pageNum}: ${err.message}`);
    }

    return null;
}

// ── Identificación escalonada con Vision ──────────────────────────────

/**
 * Orquesta la cascada de identificación de código en una página,
 * respetando un presupuesto máximo de llamadas API.
 *
 * Orden de intentos:
 *   1. identifyDocNumber (prompt principal)
 *   2. identifyDocNumberRetry (prompt minimalista)
 *   3. Imagen mejorada + identifyDocNumber
 *   4. Crops amplios + enhanced + identifyDocNumber
 *   5. identifyExpectedDocNumberMultiPass (barrido exhaustivo dirigido)
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

    // Paso 3: Imagen mejorada + identificación
    logger.info(`  [RETRY] Pagina ${pageNum} - Intento con imagen mejorada (enhanced)...`);
    try {
        const enhancedBuffer = await enhanceForHandwriting(pngBuffer);
        result = await withBudget(
            () => identifyDocNumber(enhancedBuffer, pageNum),
            'identifyDocNumber(enhanced)'
        );
        if (result) return result;

        // Paso 4A: Franja superior + enhanced
        if (apiCalls < budget) {
            logger.info(`  [RETRY] Pagina ${pageNum} - Intento con franja superior + enhanced...`);
            const croppedBuffer = await cropTopSection(pngBuffer, ASFI_CROP_FRACTION);
            const enhancedCrop = await enhanceForHandwriting(croppedBuffer);
            result = await withBudget(
                () => identifyDocNumber(enhancedCrop, pageNum),
                'identifyDocNumber(cropTop+enhanced)'
            );
            if (result) return result;
        }

    } catch (enhanceErr) {
        logger.warn(`  [ENHANCE] Error en preprocesamiento pagina ${pageNum}: ${enhanceErr.message}`);
    }

    // Paso 5: Barrido dirigido con códigos pendientes (6 vistas)
    if (apiCalls < budget) {
        logger.info(`  [RETRY] Pagina ${pageNum} - Barrido dirigido con codigos pendientes...`);
        result = await identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, pendingAdjuntos);
        apiCalls += 7; // barrido dirigido consume 6 vistas + 1 enhanced
        if (result) return result;
    }

    logger.debug(`  [BUDGET] Pagina ${pageNum}: total de llamadas API: ${apiCalls}/${budget}`);
    return null;
}

// ── Funcion principal exportada ───────────────────────────────────────

/**
 * Procesa un archivo TIFF completo:
 *
 *  Fase 1: Vision de carátula (puede ser multi-página) → extraer documentos_adjuntos
 *  Fase 2: Identificación escalonada de números en páginas 2+
 *  Fase 3: Vision selectiva + extracción de datos de adjuntos que coinciden
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
    const outputPath = path.join(outputDir, `${baseName}_vision.txt`);
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
    // FASE 1: Vision de caratula (puede ser multi-pagina) + extraccion
    // ===================================================================

    logger.info('[FASE 1] Transcripcion Vision de la caratula (pagina 1)...');
    const page1Png = await extractPageAsPng(tiffPath, 0, HIGH_RES_WIDTH);
    const page1SizeKB = (page1Png.length / 1024).toFixed(1);
    const page1Text = await transcribeWithVision(page1Png, 1);
    logger.info(`  [PAGE] Pagina 1/${numPages} (${page1SizeKB} KB) - Caratula [Vision ${config.model}]`);

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

    const coverTexts = [page1Text];

    for (let ci = 1; ci < coverPageCount && ci < numPages; ci++) {
        const coverPng = await extractPageAsPng(tiffPath, ci, HIGH_RES_WIDTH);
        const coverSizeKB = (coverPng.length / 1024).toFixed(1);
        const coverText = await transcribeWithVision(coverPng, ci + 1);
        coverTexts.push(coverText);
        logger.info(`  [PAGE] Pagina ${ci + 1}/${numPages} (${coverSizeKB} KB) - Caratula (cont.) [Vision ${config.model}]`);
    }

    const fullCoverText = coverTexts.join('\n\n');
    const extractedData = await extractFields(fullCoverText);

    const adjuntos = extractedData.documentos_adjuntos || [];
    const suspiciousAdjuntos = countSuspiciousAdjuntos(adjuntos);

    if (suspiciousAdjuntos > 0) {
        logger.warn(`[FASE 1] Se detectaron ${suspiciousAdjuntos} adjunto(s) con formato sospechoso despues de Vision. Revisa la caratula o sube OPENAI_MODEL a un modelo mas fuerte.`);
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
    // FASE 2: Identificación PARALELA de números (páginas después de carátula)
    // ===================================================================

    const ubicacion_adjuntos = [];
    const allText = [...coverTexts];
    const matchedCodes = new Set();
    let pendingAdjuntos = [...adjuntos];
    let successCount = coverPageCount;
    let errorCount = 0;
    let skippedCount = 0;

    // Almacena resultados de identificación por pageIndex para Fase 3
    const idResults = {};

    // Pre-inicializar allText para todas las páginas (permite asignación por índice en continuaciones)
    for (let pi = coverPageCount; pi < numPages; pi++) {
        allText.push('');
    }

    if (adjuntos.length > 0 && numPages > coverPageCount) {
        const pageConcurrency = config.concurrency;
        logger.info(`[FASE 2] Identificando numeros en paginas ${coverPageCount + 1}-${numPages} (${pageConcurrency} en paralelo)...`);

        // Procesar páginas en lotes paralelos para identificación
        for (let batchStart = coverPageCount; batchStart < numPages; batchStart += pageConcurrency) {
            if (pendingAdjuntos.length === 0) {
                logger.info(`  [SKIP] Todos los codigos encontrados (${matchedCodes.size}). Omitiendo paginas ${batchStart + 1}-${numPages}.`);
                for (let pi = batchStart; pi < numPages; pi++) {
                    idResults[pi] = { pageIndex: pi, pageNum: pi + 1, code: null, pngBuffer: null, sizeKB: '0', skipped: true };
                }
                break;
            }

            const batchEnd = Math.min(batchStart + pageConcurrency, numPages);
            const pendingSnapshot = [...pendingAdjuntos];

            // Lanzar identificación de todas las páginas del lote en paralelo
            const batchPromises = [];
            for (let pi = batchStart; pi < batchEnd; pi++) {
                const pageNum = pi + 1;
                batchPromises.push((async () => {
                    try {
                        const pngBuffer = await extractPageAsPng(tiffPath, pi, HIGH_RES_WIDTH);
                        const sizeKB = (pngBuffer.length / 1024).toFixed(1);
                        let code = await identifyPageCode(pngBuffer, pageNum, pendingSnapshot);

                        // Si el código no coincide, intento dirigido
                        if (code) {
                            const quickMatch = matchSingleNumber(code, pendingSnapshot);
                            if (!quickMatch.matched) {
                                logger.info(`  [RETRY] Pagina ${pageNum}/${numPages} - Codigo "${code}" no coincide. Intento dirigido...`);
                                const targetedNumber = await identifyExpectedDocNumberMultiPass(pngBuffer, pageNum, pendingSnapshot);
                                if (targetedNumber) {
                                    const targetedMatch = matchSingleNumber(targetedNumber, pendingSnapshot);
                                    if (targetedMatch.matched) {
                                        logger.info(`  [ID TARGET] Pagina ${pageNum}/${numPages} - Codigo corregido: ${targetedNumber}`);
                                        code = targetedNumber;
                                    }
                                }
                            }
                        }

                        return { pageIndex: pi, pageNum, code, pngBuffer, sizeKB, error: null };
                    } catch (err) {
                        return { pageIndex: pi, pageNum: pi + 1, code: null, pngBuffer: null, sizeKB: '0', error: err };
                    }
                })());
            }

            const batchResults = await Promise.all(batchPromises);

            // Procesar resultados del lote SECUENCIALMENTE (orden de página) para matching consistente
            for (const result of batchResults.sort((a, b) => a.pageIndex - b.pageIndex)) {
                idResults[result.pageIndex] = result;

                if (result.error) {
                    logger.error(`  [ERROR] Pagina ${result.pageNum}/${numPages}: ${result.error.message}`);
                    errorCount++;
                    continue;
                }

                if (!result.code) {
                    logger.info(`  [ID] Pagina ${result.pageNum}/${numPages} (${result.sizeKB} KB) - Sin codigo`);
                    continue;
                }

                // Fuzzy match contra adjuntos PENDIENTES actuales
                const matchResult = matchSingleNumber(result.code, pendingAdjuntos);

                if (!matchResult.matched) {
                    const isAlreadyFound = matchedCodes.has(result.code.match(/R-\d{5,7}/)?.[0] || '');
                    if (isAlreadyFound) {
                        logger.warn(`  [SKIP] Pagina ${result.pageNum}/${numPages} - Codigo "${result.code}" ya encontrado`);
                    } else {
                        logger.warn(`  [SKIP] Pagina ${result.pageNum}/${numPages} - Codigo "${result.code}" no coincide (score: ${matchResult.score})`);
                    }
                    continue;
                }

                logger.info(`  [ID] Pagina ${result.pageNum}/${numPages} - Codigo: ${result.code}`);
                logger.info(`  [MATCH] Pagina ${result.pageNum} <-> ${matchResult.code} (confianza: ${(matchResult.score * 100).toFixed(0)}%)`);
                matchedCodes.add(matchResult.code);
                pendingAdjuntos = pendingAdjuntos.filter(doc => extractDocCode(doc) !== matchResult.code);
                logger.info(`  [INFO] Codigo "${matchResult.code}" removido. Faltan ${pendingAdjuntos.length} codigos.`);

                idResults[result.pageIndex].matchResult = matchResult;
            }
        }

        // =================================================================
        // FASE 3: Vision selectiva + Extracción + Detección de continuación
        // =================================================================

        logger.info(`[FASE 3] Transcribiendo paginas con match y detectando continuaciones...`);

        for (let pageIndex = coverPageCount; pageIndex < numPages; pageIndex++) {
            const idResult = idResults[pageIndex];

            if (!idResult || idResult.skipped || idResult.error) {
                if (idResult?.error) allText[pageIndex] = `[ERROR] Pagina ${idResult.pageNum}: ${idResult.error.message}`;
                if (!idResult?.error && !idResult?.skipped) skippedCount++;
                if (idResult?.skipped) skippedCount++;
                continue;
            }

            // ── Página SIN match: omitir (será capturada como continuación si aplica)
            if (!idResult.matchResult) {
                skippedCount++;
                continue;
            }

            // ── Página CON match: transcribir + extraer + buscar continuaciones
            try {
                const { pageNum, pngBuffer, sizeKB, code } = idResult;
                let matchResult = idResult.matchResult;
                let identifiedNumber = code;

                logger.info(`  [VISION] Transcribiendo pagina ${pageNum}/${numPages} (${sizeKB} KB)...`);
                const visionText = (await transcribeWithVision(pngBuffer, pageNum)) || '';
                allText[pageIndex] = visionText;
                successCount++;

                const reconciledMatch = reconcileMatchWithVisionText(matchResult, visionText, [...adjuntos]);
                if (reconciledMatch.matched && reconciledMatch.code !== matchResult.code) {
                    logger.info(`  [RECONCILE] Pagina ${pageNum}/${numPages} - Codigo corregido por OCR: ${matchResult.code} -> ${reconciledMatch.code}`);
                    matchResult = reconciledMatch;
                    identifiedNumber = reconciledMatch.code;
                }

                // ── Detección de páginas de continuación ──────────────
                // Buscar páginas siguientes SIN código propio como continuación de tabla
                const continuationTexts = [];
                let peekIndex = pageIndex + 1;
                const MAX_CONTINUATION_PAGES = 10;

                while (peekIndex < numPages && continuationTexts.length < MAX_CONTINUATION_PAGES) {
                    const nextIdResult = idResults[peekIndex];
                    // Si la siguiente página tiene match propio, parar
                    if (nextIdResult?.matchResult) break;
                    // Si la siguiente página tiene código (aunque no matchee), parar
                    if (nextIdResult?.code) break;
                    // Si es skipped o error, parar
                    if (!nextIdResult || nextIdResult.skipped || nextIdResult.error) break;

                    // Candidata a continuación → transcribir
                    try {
                        const contPng = nextIdResult.pngBuffer || await extractPageAsPng(tiffPath, peekIndex, HIGH_RES_WIDTH);
                        const contSizeKB = (contPng.length / 1024).toFixed(1);
                        logger.info(`  [CONT] Pagina ${peekIndex + 1}/${numPages} (${contSizeKB} KB) - Posible continuacion de tabla...`);
                        const contText = (await transcribeWithVision(contPng, peekIndex + 1)) || '';

                        if (contText.trim().length > 0) {
                            continuationTexts.push(contText);
                            allText[peekIndex] = contText; // Actualizar en allText (puede estar como '')
                            successCount++;
                            // Decrementar skippedCount ya que esta página ahora se procesa
                            if (skippedCount > 0) skippedCount--;
                            logger.success(`  [CONT] Pagina ${peekIndex + 1} agregada como continuacion (${contText.length} chars)`);
                        } else {
                            break; // Página vacía → fin de continuación
                        }
                    } catch (contErr) {
                        logger.warn(`  [CONT] Error en pagina ${peekIndex + 1}: ${contErr.message}`);
                        break;
                    }

                    peekIndex++;
                }

                if (continuationTexts.length > 0) {
                    logger.info(`  [CONT] ${continuationTexts.length} pagina(s) de continuacion detectadas para ${matchResult.code}`);
                }

                // Extraer datos con todas las páginas (principal + continuaciones)
                let extractionText = [visionText, ...continuationTexts].join('\n\n');
                const totalPages = 1 + continuationTexts.length;
                logger.info(`  [EXTRACT] Extrayendo datos del adjunto (${extractionText.length} chars, ${totalPages} pagina${totalPages > 1 ? 's' : ''})...`);
                let adjuntoData = await extractAdjuntoFields(extractionText);

                let hasCriticalFields = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);

                // Vision+1: Si no hay continuaciones detectadas y faltan campos críticos
                if (continuationTexts.length === 0 && !hasCriticalFields) {
                    const nextPageIndex = pageIndex + 1;
                    if (nextPageIndex < numPages) {
                        try {
                            const nextPng = await extractPageAsPng(tiffPath, nextPageIndex, HIGH_RES_WIDTH);
                            const nextSizeKB = (nextPng.length / 1024).toFixed(1);
                            logger.info(`  [VISION+1] Campos criticos vacios. Transcribiendo pagina ${nextPageIndex + 1}/${numPages} (${nextSizeKB} KB)...`);
                            const nextPageText = (await transcribeWithVision(nextPng, nextPageIndex + 1)) || '';

                            if (nextPageText.trim().length > 0) {
                                extractionText = visionText + '\n\n' + nextPageText;
                                logger.info(`  [EXTRACT] Re-extrayendo con 2 paginas (${extractionText.length} chars)...`);
                                adjuntoData = await extractAdjuntoFields(extractionText);
                                hasCriticalFields = adjuntoData.nro_cite || adjuntoData.demandante || (adjuntoData.demandados && adjuntoData.demandados.length > 0);
                            }
                        } catch (nextErr) {
                            logger.warn(`  [VISION+1] Error en pagina ${nextPageIndex + 1}: ${nextErr.message}`);
                        }
                    }
                }

                // Fallback: páginas anteriores con Vision
                if (!hasCriticalFields && pageIndex > coverPageCount) {
                    const startIdx = Math.max(coverPageCount, pageIndex - MAX_PREV_PAGES_FALLBACK);
                    logger.info(`  [FALLBACK] Campos criticos vacios. Buscando contexto en paginas anteriores ${startIdx + 1}-${pageNum} con Vision...`);

                    let combinedText = '';
                    for (let prevIdx = startIdx; prevIdx < pageIndex; prevIdx++) {
                        try {
                            const prevPng = await extractPageAsPng(tiffPath, prevIdx, HIGH_RES_WIDTH);
                            const prevText = (await transcribeWithVision(prevPng, prevIdx + 1)) || '';
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
                            logger.success('  [FALLBACK] Campos criticos recuperados con Vision');
                        } else {
                            logger.warn('  [FALLBACK] Aun sin campos criticos despues del fallback multi-pagina Vision');
                        }
                    }
                }

                if (!adjuntoData.juez) {
                    const recoveredJudge = await recoverMissingJudge(pngBuffer, pageNum);
                    if (recoveredJudge) {
                        adjuntoData.juez = recoveredJudge;
                    }
                }

                ubicacion_adjuntos.push({
                    documento: matchResult.documento,
                    id_buscado: matchResult.code,
                    id_encontrado: identifiedNumber,
                    pagina: pageNum,
                    paginas_continuacion: continuationTexts.length > 0 ? continuationTexts.length : undefined,
                    confianza: matchResult.score,
                    ...adjuntoData
                });

                // Avanzar pageIndex más allá de las páginas de continuación ya procesadas
                if (continuationTexts.length > 0) {
                    pageIndex += continuationTexts.length;
                }

            } catch (err) {
                logger.error(`  [ERROR] Pagina ${idResult.pageNum}/${numPages}: ${err.message}`);
                allText[pageIndex] = `[ERROR] Pagina ${idResult.pageNum}: ${err.message}`;
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
    stream.write(`Vision con ${modelLabel()} - Extraccion de texto\n`);
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

    // ── JSON de salida con auditoria y deteccion de errores ──────────

    // Detectar errores y advertencias en los adjuntos extraidos
    const adjuntosConError = ubicacion_adjuntos.filter(a => a._error);
    const adjuntosConTruncado = ubicacion_adjuntos.filter(a => a._advertencia_truncado);
    const advertencias = [];

    if (adjuntosConError.length > 0) {
        advertencias.push(`${adjuntosConError.length} adjunto(s) con error de extraccion: ${adjuntosConError.map(a => a.id_buscado).join(', ')}`);
    }
    if (adjuntosConTruncado.length > 0) {
        advertencias.push(`${adjuntosConTruncado.length} adjunto(s) con texto truncado (posible perdida de demandados): ${adjuntosConTruncado.map(a => a.id_buscado).join(', ')}`);
    }
    if (notFound.length > 0) {
        advertencias.push(`${notFound.length} codigo(s) no encontrados en el documento`);
    }
    if (errorCount > 0) {
        advertencias.push(`${errorCount} pagina(s) con errores de procesamiento`);
    }

    const tieneErrores = adjuntosConError.length > 0 || notFound.length > 0 || errorCount > 0;

    // Calcular hash SHA-256 del archivo original para trazabilidad
    let archivoHash = '';
    try {
        const fileBuffer = fs.readFileSync(tiffPath);
        archivoHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } catch { /* si falla el hash, no bloquear */ }

    const jsonOutput = {
        archivo_origen: path.basename(tiffPath),
        fecha_procesamiento: now,
        total_paginas: numPages,
        paginas_transcritas: successCount,
        paginas_omitidas: skippedCount,
        tiene_errores: tieneErrores,
        advertencias: advertencias.length > 0 ? advertencias : undefined,
        ...extractedData,
        ubicacion_adjuntos: ubicacion_adjuntos.length > 0 ? ubicacion_adjuntos : undefined,
        codigos_no_encontrados: notFound.length > 0 ? notFound.map(d => extractDocCode(d) || 'SIN_CODIGO') : undefined,
        _auditoria: {
            modelo: modelLabel(),
            version_sistema: '2.1.0',
            fecha_iso: new Date().toISOString(),
            hash_archivo_sha256: archivoHash || undefined,
            adjuntos_con_error: adjuntosConError.length > 0 ? adjuntosConError.map(a => a.id_buscado) : undefined,
            adjuntos_truncados: adjuntosConTruncado.length > 0 ? adjuntosConTruncado.map(a => a.id_buscado) : undefined
        }
    };

    // Escritura atomica: escribir a .tmp, verificar, luego renombrar
    const tmpJsonPath = jsonPath + '.tmp';
    try {
        const jsonContent = JSON.stringify(jsonOutput, null, 2);
        fs.writeFileSync(tmpJsonPath, jsonContent, 'utf-8');

        // Verificar integridad leyendo de vuelta
        const written = fs.readFileSync(tmpJsonPath, 'utf-8');
        JSON.parse(written); // Si falla el parseo, el JSON esta corrupto

        // Rename atomico (misma particion)
        fs.renameSync(tmpJsonPath, jsonPath);
        logger.success(`[JSON] JSON guardado con integridad verificada: ${path.basename(jsonPath)}`);
    } catch (jsonErr) {
        // Si falla la escritura atomica, intentar escribir directamente
        logger.error(`[JSON] Error en escritura atomica: ${jsonErr.message}. Intentando escritura directa...`);
        fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');
        logger.warn(`[JSON] JSON guardado sin verificacion de integridad: ${path.basename(jsonPath)}`);
    } finally {
        // Limpiar archivo temporal si existe
        try { if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath); } catch { /* ignore */ }
    }

    if (tieneErrores) {
        logger.warn(`⚠️ Completado CON ERRORES: ${path.basename(tiffPath)} (${elapsedStr}) - ${successCount} transcritas, ${skippedCount} omitidas, ${adjuntosConError.length} con error`);
    } else {
        logger.success(`Completado: ${path.basename(tiffPath)} (${elapsedStr}) - ${successCount} transcritas, ${skippedCount} omitidas`);
    }

    return { outputPath, jsonPath, numPages, success: successCount, errors: errorCount, skipped: skippedCount, elapsed: elapsedStr, extractedData: jsonOutput };
}
