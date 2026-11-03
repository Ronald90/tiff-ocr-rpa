import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import {
    describeOpenAIError,
    isRetryableOpenAIError,
    throwIfInsufficientQuota,
    TruncatedOutputError
} from './openai-errors.js';
import { extractFields } from './extractor.js';
import { extractAdjuntoFields, normalizeJuezValue } from './adjunto-extractor.js';
import { withOpenAIUsage } from './completion-cache.js';
import {
    matchSingleNumber,
    extractDocCode,
    extractRCodes,
    matchPageWithDocumentsByContext,
    matchPageWithDocumentsByStamp,
    extractDocDateKey,
    extractPageDateKeys
} from './fuzzy-match.js';
import { sleep, renderPrompt, modelLabel, formatTime } from './utils.js';

// ── Constantes ────────────────────────────────────────────────────────

/** Recortes focalizados para recuperar el nombre del juez en el bloque de firma */
const JUDGE_SIGNATURE_REGIONS = [
    { label: 'franja inferior', region: { left: 0, top: 0.68, width: 1, height: 0.32 } },
    { label: 'bloque inferior derecho', region: { left: 0.42, top: 0.56, width: 0.58, height: 0.44 } }
];

/** Sigma para sharpening de imagen manuscrita */
const HANDWRITING_SHARPEN_SIGMA = 2;

/** Multiplicador de contraste para mejora de manuscrito */
const HANDWRITING_CONTRAST = 1.5;

/** Longitud máxima de texto para considerar como rechazo del modelo */
const REFUSAL_MAX_LENGTH = 200;

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
    const image = sharp(tiffPath, { page: pageIndex });
    const meta = await image.metadata();

    // detail:original rechaza imágenes que superan 30 000 parches de 32 px.
    // El margen evita exceder el límite por el redondeo de cada dimensión.
    const maxPixels = config.maxImagePatches * 32 * 32;
    const scale = Math.min(1, maxWidth / meta.width, Math.sqrt(maxPixels / (meta.width * meta.height)));
    if (scale < 1) {
        image.resize({ width: Math.max(1, Math.floor(meta.width * scale)), withoutEnlargement: true });
    }

    return image.png({ compressionLevel: 6 }).toBuffer();
}

/**
 * Comprueba la página original, antes de cualquier reducción para Vision. Un
 * escaneo real nunca es uniforme: la mediana borra motas aisladas. Solo una
 * página sin ningún píxel oscuro tras el filtro se acepta como vacía. stats()
 * de sharp mide la imagen de entrada sin aplicar la mediana.
 */
export async function isVisuallyBlankPage(tiffPath, pageIndex) {
    const pixels = await sharp(tiffPath, { page: pageIndex })
        .removeAlpha()
        .toColourspace('b-w')
        .median(config.blankPageMedianPx)
        .raw()
        .toBuffer();
    for (const value of pixels) {
        if (value < config.blankPageDarkThreshold) return false;
    }
    return true;
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

function mergeCoverRCodesWithAdjuntos(adjuntos = [], coverText = '') {
    const merged = [...adjuntos];
    const existingCodes = new Set(merged.map(extractDocCode).filter(Boolean));
    const coverCodes = extractRCodes(coverText);

    for (const code of coverCodes) {
        if (existingCodes.has(code)) continue;
        merged.push(code);
        existingCodes.add(code);
        logger.warn(`[FASE 1] Codigo ${code} visible en caratula agregado por respaldo deterministico.`);
    }

    return merged;
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

function normalizeCodeForAudit(value = '') {
    const extracted = extractDocCode(value);
    if (extracted?.startsWith('R-')) return extracted;

    const digits = String(value).replace(/\D/g, '');
    if (digits.length >= 5 && digits.length <= 7) return `R-${digits}`;

    return String(value || '');
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
    let maxTokens = config.ocrMaxOutputTokens;

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
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: config.ocrImageDetail } }
                        ]
                    }
                ],
                reasoning_effort: config.ocrReasoningEffort,
                max_completion_tokens: maxTokens
            }, { signal: controller.signal });

            if (response.choices?.[0]?.finish_reason === 'length') {
                throw new TruncatedOutputError(`OCR truncado en pagina ${pageNum}: limite de ${maxTokens} tokens de salida`);
            }
            const text = response.choices?.[0]?.message?.content;
            if (text === null || text === undefined) throw new Error(`OCR sin contenido en pagina ${pageNum}`);

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
                                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: config.ocrImageDetail } }
                                ]
                            }
                        ],
                        reasoning_effort: config.ocrReasoningEffort,
                        max_completion_tokens: maxTokens
                    }, { signal: controller.signal });

                    if (fallbackResponse.choices?.[0]?.finish_reason === 'length') {
                        throw new TruncatedOutputError(`OCR fallback truncado en pagina ${pageNum}: limite de ${maxTokens} tokens de salida`);
                    }
                    const fallbackText = fallbackResponse.choices?.[0]?.message?.content;
                    if (fallbackText === null || fallbackText === undefined) throw new Error(`OCR fallback sin contenido en pagina ${pageNum}`);
                    logger.info(`[FALLBACK] Pagina ${pageNum} transcrita con ${model} correctamente`);
                    return fallbackText;
                } catch (fallbackErr) {
                    throwIfInsufficientQuota(fallbackErr, `OpenAI fallback pagina ${pageNum}`);
                    logger.error(`[FALLBACK] Error con ${model} en pagina ${pageNum}: ${fallbackErr.message}`);
                    throw fallbackErr;
                }
            }

            return text;
        } catch (err) {
            throwIfInsufficientQuota(err, `OpenAI pagina ${pageNum}`);

            // Repetir con el mismo tope volveria a truncar: se reintenta una
            // sola vez, con el doble de tokens.
            if (err instanceof TruncatedOutputError && maxTokens === config.ocrMaxOutputTokens && attempt < config.maxRetries) {
                maxTokens *= 2;
                logger.warn(`Reintento ${attempt}/${config.maxRetries} para pagina ${pageNum}: salida truncada, ahora con ${maxTokens} tokens`);
                continue;
            }
            if (attempt === config.maxRetries || !isRetryableOpenAIError(err)) throw err;

            const isRateLimit = err.status === 429;
            const waitTime = isRateLimit ? config.retryDelayMs * attempt : config.retryDelayMs;
            const detail = describeOpenAIError(err);
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
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: config.ocrImageDetail } }
                    ]
                }
            ],
            reasoning_effort: config.ocrReasoningEffort,
            max_completion_tokens: config.idMaxOutputTokens
        }, { signal: controller.signal });

        const raw = (response.choices?.[0]?.message?.content ?? '').trim();
        const normalized = normalizeJuezValue(raw);
        if (normalized) {
            logger.info(`  [JUEZ] Pagina ${pageNum} - Nombre recuperado desde ${label}: ${normalized}`);
            return normalized;
        }

        return '';
    } catch (err) {
        throwIfInsufficientQuota(err, `OpenAI juez pagina ${pageNum}`);
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
async function identifyDocNumber(pngBuffer, pageNum, { model = config.idModel, reasoningEffort = config.idReasoningEffort, cacheMode } = {}) {
    const imgBase64 = pngBuffer.toString('base64');

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutPerPageMs);

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
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: config.idImageDetail } }
                    ]
                }
            ];

            const response = await openai.chat.completions.create({
                model,
                messages,
                reasoning_effort: reasoningEffort,
                max_completion_tokens: config.idMaxOutputTokens
            }, { signal: controller.signal, cacheMode });

            let result = (response.choices?.[0]?.message?.content ?? '').trim();

            // Manejar rechazos del modelo
            if (isModelRefusal(result)) {
                logger.warn(`[ID REFUSAL] Modelo ${model} se nego en pagina ${pageNum}. Reintentando con prompt fallback...`);
                try {
                    const fallbackResponse = await openai.chat.completions.create({
                        model,
                        messages,
                        reasoning_effort: reasoningEffort,
                        max_completion_tokens: config.idMaxOutputTokens
                    }, { signal: controller.signal, cacheMode });
                    result = (fallbackResponse.choices?.[0]?.message?.content ?? '').trim();
                    logger.info(`[ID FALLBACK] Pagina ${pageNum} identificada con ${model}`);
                } catch (fallbackErr) {
                    throwIfInsufficientQuota(fallbackErr, `OpenAI identificacion fallback pagina ${pageNum}`);
                    logger.error(`[ID FALLBACK] Error con ${model} en pagina ${pageNum}: ${fallbackErr.message}`);
                    throw fallbackErr;
                }
            }

            return normalizeIdentifiedCode(result);

        } catch (err) {
            throwIfInsufficientQuota(err, `OpenAI identificacion pagina ${pageNum}`);

            if (attempt === config.maxRetries || !isRetryableOpenAIError(err)) {
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

// ── Identificacion dirigida contra codigos pendientes ─────────────────

/**
 * Identificación dirigida: le muestra al modelo los códigos esperados.
 * @param {Buffer} pngBuffer - Buffer PNG de la página
 * @param {number} pageNum - Número de página
 * @param {string[]} documentList - Lista de documentos adjuntos pendientes
 * @returns {Promise<string|null>} - Código normalizado o null
 */
async function identifyExpectedDocNumber(pngBuffer, pageNum, documentList) {
    const model = config.idModel;
    const expectedCodes = [...new Set(documentList.map(extractDocCode).filter(Boolean))];
    if (expectedCodes.length === 0) return null;

    const imgBase64 = pngBuffer.toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutPerPageMs);

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
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}`, detail: config.idImageDetail } }
                    ]
                }
            ],
            reasoning_effort: config.idReasoningEffort,
            max_completion_tokens: config.idMaxOutputTokens
        }, { signal: controller.signal });

        const result = (response.choices?.[0]?.message?.content ?? '').trim();
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
        throwIfInsufficientQuota(err, `OpenAI identificacion dirigida pagina ${pageNum}`);
        logger.warn(`  [ID TARGET] Error en identificacion dirigida pagina ${pageNum} con ${model}: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// ── Ejecucion concurrente en orden ────────────────────────────────────

/**
 * Ejecuta `work` sobre los índices [from, to) con hasta `concurrency` tareas en
 * curso y entrega cada resultado a `onResult` en orden de índice. Una tarea
 * lenta no frena a las demás: cada trabajador toma el siguiente índice libre.
 * `canStart` se consulta antes de lanzar cada índice para dejar de lanzar
 * tareas que ya no hacen falta.
 * @param {{ from: number, to: number, concurrency: number, work: (index: number) => Promise<any>, onResult: (result: any, index: number) => void, canStart?: (index: number) => boolean }} options
 * @returns {Promise<number>} - Primer índice que no se lanzó
 */
async function runInOrder({ from, to, concurrency, work, onResult, canStart = () => true }) {
    const finished = new Map();
    let next = from;
    let delivered = from;
    let failure = null;

    async function worker() {
        while (!failure && next < to && canStart(next)) {
            const index = next++;
            try {
                finished.set(index, await work(index));
            } catch (err) {
                failure = err;
                return;
            }

            while (finished.has(delivered)) {
                onResult(finished.get(delivered), delivered);
                finished.delete(delivered);
                delivered++;
            }
        }
    }

    const workers = Math.max(1, Math.min(concurrency, to - from));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (failure) throw failure;
    return next;
}

// ── Lectura de paginas ────────────────────────────────────────────────

/**
 * Lee una página: la transcribe y busca su código en ese texto. Solo si el
 * texto no muestra con claridad un código de la carátula, lo busca en la
 * imagen con el modelo de identificación.
 * @param {string} tiffPath - Ruta al archivo TIFF
 * @param {number} pageIndex - Índice de página (0-based)
 * @param {string[]} adjuntos - Documentos adjuntos listados en la carátula
 * @returns {Promise<{pageIndex: number, pageNum: number, sizeKB: string, text: string, code: string|null, codeSource: string|null, error: Error|null}>}
 */
async function readPage(tiffPath, pageIndex, adjuntos) {
    const pageNum = pageIndex + 1;

    try {
        const pngBuffer = await extractPageAsPng(tiffPath, pageIndex);
        const sizeKB = (pngBuffer.length / 1024).toFixed(1);
        let text = (await transcribeWithVision(pngBuffer, pageNum)) || '';

        if (!text.trim()) {
            // La primera respuesta vacía no prueba que la página esté en blanco.
            // La caché no guarda respuestas vacías, así que se repite antes de
            // decidir si se puede omitir la página.
            logger.warn(`[OCR] Pagina ${pageNum}: texto vacio; se repite la transcripcion antes de comprobar si esta en blanco`);
            text = (await transcribeWithVision(pngBuffer, pageNum)) || '';
            if (!text.trim()) {
                if (await isVisuallyBlankPage(tiffPath, pageIndex)) {
                    return { pageIndex, pageNum, sizeKB, text: '', code: null, codeSource: null, blank: true, error: null };
                }
                throw new Error(`OCR vacio en pagina ${pageNum} con contenido visible; requiere revision`);
            }
        }

        const stampMatch = matchPageWithDocumentsByStamp(text, adjuntos);
        if (stampMatch.matched) {
            return { pageIndex, pageNum, sizeKB, text, code: stampMatch.candidate, codeSource: 'texto', error: null };
        }

        const code = await identifyDocNumber(pngBuffer, pageNum);
        return { pageIndex, pageNum, sizeKB, text, code, codeSource: code ? 'imagen' : null, error: null };
    } catch (err) {
        throwIfInsufficientQuota(err, `OpenAI pagina ${pageNum}`);
        return { pageIndex, pageNum, sizeKB: '0', text: '', code: null, codeSource: null, error: err };
    }
}

/**
 * Detecta cuántas páginas ocupa la carátula a partir de su paginación
 * (por ejemplo "Pág. 1 de 2").
 * @param {string} page1Text - Transcripción de la primera página
 * @param {number} numPages - Total de páginas del TIFF
 * @returns {number}
 */
function detectCoverPageCount(page1Text, numPages) {
    let pagMatch = page1Text.match(/P[a-záéíóúäëïöü_.:,'"\\-\\|]{1,4}g[^\d]*(\d+)\s*de\s*(\d+)/i) ||
        page1Text.match(/(?:p[áa]gina|pag|p[áa]g\.?)\s*(\d+)\s*(?:\/|de)\s*(\d+)/i);

    if (!pagMatch) {
        const endText = page1Text.slice(-1000);
        pagMatch = endText.match(/(?:\n|^)\s*(\d+)\s*de\s*(\d+)\s*(?:\n|$)/i);
    }

    if (!pagMatch) return 1;

    const coverPageCount = parseInt(pagMatch[2], 10);
    return coverPageCount > 1 && coverPageCount <= numPages ? coverPageCount : 1;
}

// ── Ubicacion de adjuntos ─────────────────────────────────────────────

/**
 * Lee las páginas posteriores a la carátula y asigna a cada código de la
 * carátula la página que lo lleva.
 *
 * Cada página se transcribe una sola vez: casi todas hacen falta igual, como
 * adjunto o como continuación. Al ubicar todos los códigos se dejan de leer
 * páginas, salvo las posibles continuaciones del último adjunto. Si quedan
 * códigos pendientes se rescatan con identificación dirigida y luego con el
 * texto completo de las páginas sin match.
 *
 * @param {string} tiffPath - Ruta al archivo TIFF
 * @param {number} numPages - Total de páginas
 * @param {number} coverPageCount - Páginas de carátula
 * @param {string[]} adjuntos - Documentos adjuntos listados en la carátula
 * @returns {Promise<{pages: Array<object|null>, matchedCodes: Set<string>, errorCount: number}>}
 */
async function locateAdjuntos(tiffPath, numPages, coverPageCount, adjuntos) {
    const pages = new Array(numPages).fill(null);
    const matchedCodes = new Set();
    let pending = [...adjuntos];
    let errorCount = 0;
    let lastPageToRead = Infinity;

    function assignMatch(page, match) {
        page.match = match;
        matchedCodes.add(match.code);
        pending = pending.filter(doc => extractDocCode(doc) !== match.code);
        logger.info(`  [MATCH] Pagina ${page.pageNum} <-> ${match.code} (confianza: ${(match.score * 100).toFixed(0)}%). Faltan ${pending.length} codigos.`);
    }

    logger.info(`[FASE 2] Transcribiendo e identificando paginas ${coverPageCount + 1}-${numPages} (${config.concurrency} en paralelo)...`);

    const firstUnread = await runInOrder({
        from: coverPageCount,
        to: numPages,
        concurrency: config.concurrency,
        work: pageIndex => readPage(tiffPath, pageIndex, adjuntos),
        canStart: pageIndex => pageIndex <= lastPageToRead,
        // Los resultados llegan en orden de página para que dos páginas nunca
        // se queden con el mismo código.
        onResult: page => {
            pages[page.pageIndex] = page;
            const wasPending = pending.length > 0;

            if (page.error) {
                logger.error(`  [ERROR] Pagina ${page.pageNum}/${numPages}: ${page.error.message}`);
                errorCount++;
            } else if (!page.code) {
                logger.info(`  [ID] Pagina ${page.pageNum}/${numPages} (${page.sizeKB} KB) - Sin codigo`);
            } else {
                const match = matchSingleNumber(page.code, pending);
                if (match.matched) {
                    logger.info(`  [ID] Pagina ${page.pageNum}/${numPages} (${page.sizeKB} KB) - Codigo: ${page.code} (${page.codeSource})`);
                    assignMatch(page, match);
                } else if (matchedCodes.has(page.code.match(/R-\d{5,7}/)?.[0] || '')) {
                    logger.warn(`  [SKIP] Pagina ${page.pageNum}/${numPages} - Codigo "${page.code}" ya encontrado`);
                } else {
                    logger.warn(`  [SKIP] Pagina ${page.pageNum}/${numPages} - Codigo "${page.code}" no coincide (score: ${match.score})`);
                }
            }

            // Con todos los codigos ubicados solo faltan las continuaciones del
            // ultimo adjunto, que terminan en la primera pagina con codigo o
            // con error. Una pagina en blanco no las corta.
            if (!wasPending && (page.error || page.code)) {
                lastPageToRead = Math.min(lastPageToRead, page.pageIndex);
            }
        }
    });

    if (firstUnread < numPages) {
        logger.info(`  [SKIP] Todos los codigos encontrados (${matchedCodes.size}). Omitiendo paginas ${firstUnread + 1}-${numPages}.`);
    }

    if (pending.length > 0) {
        const unmatched = pages.filter(page => page && !page.error && !page.match);
        logger.warn(`[AUDIT] Quedan ${pending.length} codigo(s) pendientes. Identificacion dirigida en ${unmatched.length} pagina(s) sin match...`);

        await runInOrder({
            from: 0,
            to: unmatched.length,
            concurrency: config.concurrency,
            canStart: () => pending.length > 0,
            work: async index => {
                const page = unmatched[index];
                try {
                    const pngBuffer = await extractPageAsPng(tiffPath, page.pageIndex);
                    return await identifyExpectedDocNumber(pngBuffer, page.pageNum, pending);
                } catch (err) {
                    throwIfInsufficientQuota(err, `OpenAI identificacion dirigida pagina ${page.pageNum}`);
                    logger.warn(`  [ID TARGET] Error en pagina ${page.pageNum}: ${err.message}`);
                    return null;
                }
            },
            onResult: (code, index) => {
                if (!code) return;
                const page = unmatched[index];
                const match = matchSingleNumber(code, pending);
                if (!match.matched) return;

                logger.info(`  [ID TARGET] Pagina ${page.pageNum}/${numPages} - Codigo corregido: ${code}`);
                page.code = code;
                assignMatch(page, match);
            }
        });
    }

    if (pending.length > 0) {
        logger.warn(`[AUDIT] Quedan ${pending.length} codigo(s) pendientes. Buscando en el texto completo de las paginas sin match...`);

        for (const page of pages) {
            if (pending.length === 0) break;
            if (!page || page.error || page.match) continue;

            const rescuedMatch = matchPageWithDocumentsByContext(page.text, pending);
            if (!rescuedMatch.matched) continue;

            logger.success(`  [AUDIT] Pagina ${page.pageNum}/${numPages} - Codigo recuperado por texto completo: ${rescuedMatch.code}`);
            page.code = rescuedMatch.code;
            page.rescuedByText = true;
            assignMatch(page, rescuedMatch);
        }
    }

    return { pages, matchedCodes, errorCount };
}

/**
 * Revisa cada match contra la transcripción completa de su página. Un match
 * solo puede pasar a un código que ninguna otra página tenga asignado.
 * @param {Array<object|null>} pages - Páginas leídas
 * @param {string[]} adjuntos - Documentos adjuntos de la carátula
 * @param {Set<string>} matchedCodes - Códigos asignados (se actualiza)
 * @param {number} numPages - Total de páginas
 */
function reconcileMatches(pages, adjuntos, matchedCodes, numPages) {
    for (const page of pages) {
        if (!page?.match) continue;

        const available = adjuntos.filter(doc => {
            const code = extractDocCode(doc);
            return code === page.match.code || !matchedCodes.has(code);
        });
        const reconciledMatch = reconcileMatchWithVisionText(page.match, page.text, available);
        if (!reconciledMatch.matched || reconciledMatch.code === page.match.code) continue;

        logger.info(`  [RECONCILE] Pagina ${page.pageNum}/${numPages} - Codigo corregido por OCR: ${page.match.code} -> ${reconciledMatch.code}`);
        matchedCodes.delete(page.match.code);
        matchedCodes.add(reconciledMatch.code);
        page.match = reconciledMatch;
        page.code = reconciledMatch.code;
    }
}

/** Contrasta cada código asignado con una nueva lectura visual exacta. */
async function verifyMatchedCodes(tiffPath, pages, numPages) {
    const matchedPages = pages.filter(page => page?.match);
    const unverified = [];
    if (matchedPages.length === 0) return unverified;

    logger.info(`[AUDIT] Verificando digito por digito ${matchedPages.length} codigo(s) en la imagen original...`);
    await runInOrder({
        from: 0,
        to: matchedPages.length,
        concurrency: config.concurrency,
        work: async index => {
            const page = matchedPages[index];
            try {
                const pngBuffer = await extractPageAsPng(tiffPath, page.pageIndex);
                // Si el primer hallazgo vino del modelo de ID, verificar con el
                // modelo OCR; si vino del OCR, verificar con el modelo de ID.
                const verifierModel = page.codeSource === 'texto' ? config.idModel : config.model;
                const visualCode = await identifyDocNumber(pngBuffer, page.pageNum, {
                    model: verifierModel,
                    reasoningEffort: page.codeSource === 'texto' ? config.idReasoningEffort : config.ocrReasoningEffort,
                    cacheMode: 'off'
                });
                if (normalizeCodeForAudit(visualCode) === normalizeCodeForAudit(page.match.code)) {
                    return { page, visualCode, additionalCode: null, croppedCode: null };
                }

                // Una lectura discrepante no invalida por sí sola el OCR de la
                // página: pedir una lectura adicional. Si los modelos de OCR e
                // ID coinciden, la lectura sigue usando ese modelo sin caché.
                const additionalModel = verifierModel === config.idModel ? config.model : config.idModel;
                const additionalCode = await identifyDocNumber(pngBuffer, page.pageNum, {
                    model: additionalModel,
                    reasoningEffort: additionalModel === config.model ? config.ocrReasoningEffort : config.idReasoningEffort,
                    cacheMode: 'off'
                });
                if (normalizeCodeForAudit(additionalCode) === normalizeCodeForAudit(page.match.code)) {
                    return { page, visualCode, additionalCode, croppedCode: null };
                }

                // El codigo manuscrito de recepcion puede quedar demasiado
                // pequeno al enviar la pagina completa. Releer la franja
                // superior sin revelar al modelo el codigo esperado.
                const topStrip = await cropRegion(pngBuffer, { left: 0, top: 0, width: 1, height: 0.25 });
                const croppedCode = await identifyDocNumber(topStrip, page.pageNum, {
                    model: config.idModel,
                    reasoningEffort: config.idReasoningEffort,
                    cacheMode: 'off'
                });
                return { page, visualCode, additionalCode, croppedCode };
            } catch (err) {
                throwIfInsufficientQuota(err, `OpenAI verificacion codigo pagina ${page.pageNum}`);
                return { page, visualCode: null, additionalCode: null, croppedCode: null };
            }
        },
        onResult: ({ page, visualCode, additionalCode, croppedCode }) => {
            const expectedCode = normalizeCodeForAudit(page.match.code);
            const observedCode = normalizeCodeForAudit(visualCode);
            const additionalObserved = additionalCode ? normalizeCodeForAudit(additionalCode) : null;
            const croppedObserved = croppedCode ? normalizeCodeForAudit(croppedCode) : null;
            page.codigo_verificado = expectedCode === observedCode || expectedCode === additionalObserved || expectedCode === croppedObserved;
            page.codigo_lectura_visual = observedCode || null;
            page.codigo_lectura_adicional = additionalObserved;
            page.codigo_lectura_recorte = croppedObserved;
            if (page.codigo_verificado) {
                if (expectedCode === croppedObserved && expectedCode !== observedCode && expectedCode !== additionalObserved) {
                    logger.warn(`  [VERIFY] Pagina ${page.pageNum}/${numPages}: ${expectedCode} confirmado en recorte superior; lecturas de pagina completa ${observedCode || 'NO_ENCONTRADO'} y ${additionalObserved || 'NO_ENCONTRADO'}`);
                } else if (expectedCode === additionalObserved && expectedCode !== observedCode) {
                    logger.warn(`  [VERIFY] Pagina ${page.pageNum}/${numPages}: ${expectedCode} confirmado en lectura adicional; primera verificacion leyo ${observedCode || 'NO_ENCONTRADO'}`);
                } else {
                    logger.success(`  [VERIFY] Pagina ${page.pageNum}/${numPages}: ${expectedCode} confirmado en imagen`);
                }
            } else {
                unverified.push({ pagina: page.pageNum, esperado: expectedCode, lectura_visual: observedCode || null });
                logger.warn(`  [VERIFY] Pagina ${page.pageNum}/${numPages}: esperado ${expectedCode}, lecturas ${observedCode || 'NO_ENCONTRADO'}, ${additionalObserved || 'NO_ENCONTRADO'} y recorte ${croppedObserved || 'NO_ENCONTRADO'}; requiere revision`);
            }
        }
    });
    return unverified;
}

/** Lee identificadores explícitos de encabezado para detectar otro documento. */
function extractPageDocumentId(text = '') {
    const citeOrOficio = text.match(/(?:^|\n)\s*(?:CITE\s*[:.\-]?\s*|OF(?:ICIO)?\.?\s*(?:N(?:RO|O|°|º)?\.?\s*)?[:.\-]?\s*)(\d{1,8}\s*\/\s*\d{4})\b/i);
    if (citeOrOficio) return citeOrOficio[1].replace(/\s+/g, '').toUpperCase();

    const circular = text.match(/(?:^|\n)\s*(CARTA\s+CIRCULAR\s*\/\s*[A-Z0-9/\-]*\d{1,8}\s*\/\s*\d{4})\b/i);
    return circular ? circular[1].replace(/\s+/g, '').toUpperCase() : null;
}

function extractDocumentHeading(text = '') {
    // Una mención de "resolución" suele ser parte de una sentencia o un
    // respaldo del adjunto R anterior. Solo un título aislado al comienzo de
    // la página es evidencia suficiente de otro oficio/circular sin código.
    const openingLines = text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8);
    const heading = openingLines.find(line => /^(?:CARTA\s+CIRCULAR|OFICIO)\s*[:.\-]?$/i.test(line));
    return heading ? heading.replace(/[\s:.\-]+$/g, '').replace(/\s+/g, ' ').toUpperCase() : null;
}

/** Agrupa páginas sin código; un encabezado distinto requiere revisión. */
function buildAdjuntoGroups(pages, coverPageCount, numPages) {
    const groups = [];

    for (let pageIndex = coverPageCount; pageIndex < numPages; pageIndex++) {
        const page = pages[pageIndex];
        if (!page?.match) continue;

        const continuation = [];
        const startId = extractPageDocumentId(page.text);
        let next = pageIndex + 1;
        for (; next < numPages; next++) {
            const candidate = pages[next];
            if (!candidate || candidate.error || candidate.match || candidate.code) break;
            const candidateId = extractPageDocumentId(candidate.text);
            if (candidateId && candidateId !== startId) {
                candidate.possibleNewDocument = candidateId;
                break;
            }
            const headingWithoutId = !candidateId && extractDocumentHeading(candidate.text);
            if (headingWithoutId) {
                candidate.possibleNewDocument = `${headingWithoutId} sin identificador legible`;
                break;
            }
            if (candidate.text.trim()) continuation.push(candidate);
        }

        groups.push({ page, continuation });
        pageIndex = next - 1;
    }

    return groups;
}

// ── Extraccion de adjuntos ────────────────────────────────────────────

/**
 * Devuelve el texto de una página y la transcribe solo si no se leyó antes
 * (omitida, con error o vacía). Una página transcrita aquí se comparte entre
 * los adjuntos que la pidan.
 * @param {string} tiffPath - Ruta al archivo TIFF
 * @param {Array<object|null>} pages - Páginas leídas
 * @param {Set<number>} transcribedPages - Índices transcritos (se actualiza)
 * @returns {(pageIndex: number) => Promise<string>}
 */
function createPageTextReader(tiffPath, pages, transcribedPages) {
    const extraReads = new Map();

    return pageIndex => {
        const known = pages[pageIndex]?.text;
        if (known && known.trim()) return Promise.resolve(known);

        if (!extraReads.has(pageIndex)) {
            extraReads.set(pageIndex, extractPageAsPng(tiffPath, pageIndex)
                .then(pngBuffer => transcribeWithVision(pngBuffer, pageIndex + 1))
                .then(text => {
                    transcribedPages.add(pageIndex);
                    return text || '';
                }));
        }
        return extraReads.get(pageIndex);
    };
}

function hasCriticalAdjuntoFields(data) {
    return Boolean(data.nro_cite || data.demandante || (data.demandados && data.demandados.length > 0));
}

/**
 * Extrae los datos de un adjunto: su página con match más las continuaciones.
 * Si faltan campos críticos puede leer la página siguiente; si falta el juez
 * lo busca en el bloque de firma de la página principal.
 * @param {{page: object, continuation: object[]}} group - Adjunto a extraer
 * @param {{tiffPath: string, numPages: number, pages: Array<object|null>, readPageText: (pageIndex: number) => Promise<string>}} doc
 * @returns {Promise<object>} - Entrada de ubicacion_adjuntos
 */
async function extractAdjuntoGroup({ page, continuation }, doc) {
    const { tiffPath, numPages, pages, readPageText } = doc;
    const { pageIndex, pageNum, sizeKB, match } = page;

    for (const cont of continuation) {
        logger.info(`  [CONT] Pagina ${cont.pageNum}/${numPages} agregada como continuacion de ${match.code} (${cont.text.length} chars)`);
    }

    let extractionText = [page.text, ...continuation.map(cont => cont.text)].join('\n\n');
    const totalPages = 1 + continuation.length;
    logger.info(`  [EXTRACT] Pagina ${pageNum}/${numPages} (${sizeKB} KB) - ${match.code}: extrayendo datos (${extractionText.length} chars, ${totalPages} pagina${totalPages > 1 ? 's' : ''})...`);
    let adjuntoData = await extractAdjuntoFields(extractionText, { primaryText: page.text });
    let hasCriticalFields = hasCriticalAdjuntoFields(adjuntoData);

    // Vision+1: si no hay continuaciones detectadas y faltan campos críticos
    if (continuation.length === 0 && !hasCriticalFields) {
        const nextPageIndex = pageIndex + 1;
        if (nextPageIndex < numPages && !pages[nextPageIndex]?.match && !pages[nextPageIndex]?.code) {
            try {
                logger.info(`  [VISION+1] Campos criticos vacios. Usando pagina ${nextPageIndex + 1}/${numPages}...`);
                const nextPageText = await readPageText(nextPageIndex);

                if (nextPageText.trim().length > 0) {
                    extractionText = page.text + '\n\n' + nextPageText;
                    logger.info(`  [EXTRACT] Re-extrayendo con 2 paginas (${extractionText.length} chars)...`);
                    adjuntoData = await extractAdjuntoFields(extractionText, { primaryText: page.text });
                    hasCriticalFields = hasCriticalAdjuntoFields(adjuntoData);
                }
            } catch (nextErr) {
                throwIfInsufficientQuota(nextErr, `OpenAI vision+1 pagina ${nextPageIndex + 1}`);
                logger.warn(`  [VISION+1] Error en pagina ${nextPageIndex + 1}: ${nextErr.message}`);
            }
        }
    }

    if (!adjuntoData.juez) {
        const pngBuffer = await extractPageAsPng(tiffPath, pageIndex);
        const recoveredJudge = await recoverMissingJudge(pngBuffer, pageNum);
        if (recoveredJudge) {
            adjuntoData.juez = recoveredJudge;
        }
    }

    const expectedAuditCode = normalizeCodeForAudit(match.code);
    const foundAuditCode = normalizeCodeForAudit(page.code);
    const matchAproximado = foundAuditCode &&
        expectedAuditCode &&
        foundAuditCode !== expectedAuditCode;

    return {
        documento: match.documento,
        id_buscado: match.code,
        id_encontrado: page.code,
        pagina: pageNum,
        codigo_verificado: page.codigo_verificado === true,
        codigo_lectura_visual: page.codigo_lectura_visual,
        codigo_lectura_adicional: page.codigo_lectura_adicional || undefined,
        codigo_lectura_recorte: page.codigo_lectura_recorte || undefined,
        paginas_continuacion: continuation.length > 0 ? continuation.length : undefined,
        confianza: match.score,
        recuperado_por_auditoria: page.rescuedByText || undefined,
        _advertencia_match_aproximado: matchAproximado
            ? `El identificador visual fue ${foundAuditCode}, se asigno a ${expectedAuditCode} por coincidencia aproximada. Revisar manualmente.`
            : undefined,
        ...adjuntoData
    };
}

/**
 * Calcula el SHA-256 de un archivo leyéndolo por partes, sin bloquear el
 * event loop ni cargar el TIFF completo en memoria.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

// ── Funcion principal exportada ───────────────────────────────────────

/**
 * Procesa un archivo TIFF completo:
 *
 *  Fase 1: Vision de carátula (puede ser multi-página) → extraer documentos_adjuntos
 *  Fase 2: Transcripción de páginas 2+ y ubicación de cada código (texto primero,
 *          imagen como respaldo), con rescate si quedan códigos pendientes
 *  Fase 3: Extracción en paralelo de los datos de cada adjunto y sus continuaciones
 *  Fase 4: Reporte de códigos no encontrados
 *
 * @param {string} tiffPath - Ruta absoluta al archivo TIFF
 * @param {string} outputDir - Directorio donde guardar los archivos de salida
 * @returns {Promise<{outputPath: string, jsonPath: string, numPages: number, success: number, errors: number, skipped: number, elapsed: string, extractedData: object}>}
 */
async function processFileImpl(tiffPath, outputDir) {
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
    const page1Png = await extractPageAsPng(tiffPath, 0);
    const page1SizeKB = (page1Png.length / 1024).toFixed(1);
    const page1Text = await transcribeWithVision(page1Png, 1);
    logger.info(`  [PAGE] Pagina 1/${numPages} (${page1SizeKB} KB) - Caratula [Vision ${config.model}]`);

    const coverPageCount = detectCoverPageCount(page1Text, numPages);
    if (coverPageCount > 1) {
        logger.info(`[FASE 1] Caratula multi-pagina detectada: ${coverPageCount} paginas`);
    }

    const coverTexts = [page1Text, ...await Promise.all(
        Array.from({ length: coverPageCount - 1 }, async (_, i) => {
            const pageIndex = i + 1;
            const coverPng = await extractPageAsPng(tiffPath, pageIndex);
            const coverText = await transcribeWithVision(coverPng, pageIndex + 1);
            logger.info(`  [PAGE] Pagina ${pageIndex + 1}/${numPages} (${(coverPng.length / 1024).toFixed(1)} KB) - Caratula (cont.) [Vision ${config.model}]`);
            return coverText;
        })
    )];
    const transcribedPages = new Set(coverTexts.map((_, pageIndex) => pageIndex));

    const fullCoverText = coverTexts.join('\n\n');
    const extractedData = await extractFields(fullCoverText);

    let adjuntos = extractedData.documentos_adjuntos || [];
    adjuntos = mergeCoverRCodesWithAdjuntos(adjuntos, fullCoverText);
    extractedData.documentos_adjuntos = adjuntos;

    const suspiciousAdjuntos = countSuspiciousAdjuntos(adjuntos);

    if (suspiciousAdjuntos > 0) {
        logger.warn(`[FASE 1] Se detectaron ${suspiciousAdjuntos} adjunto(s) con formato sospechoso despues de Vision. Revisa la caratula y los codigos extraidos.`);
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
    // FASE 2: Transcripcion de paginas + ubicacion de cada adjunto
    // ===================================================================

    const { pages, matchedCodes, errorCount: pageErrorCount } = adjuntos.length > 0 && numPages > coverPageCount
        ? await locateAdjuntos(tiffPath, numPages, coverPageCount, adjuntos)
        : { pages: new Array(numPages).fill(null), matchedCodes: new Set(), errorCount: 0 };
    let errorCount = pageErrorCount;

    for (const page of pages) {
        if (page && !page.error) transcribedPages.add(page.pageIndex);
    }

    reconcileMatches(pages, adjuntos, matchedCodes, numPages);
    const codigosNoVerificados = await verifyMatchedCodes(tiffPath, pages, numPages);

    // ===================================================================
    // FASE 3: Extraccion de datos de cada adjunto (en paralelo)
    // ===================================================================

    const groups = buildAdjuntoGroups(pages, coverPageCount, numPages);
    const paginasDocumentoNoIdentificado = pages
        .filter(page => page?.possibleNewDocument)
        .map(page => ({ pagina: page.pageNum, identificador: page.possibleNewDocument }));
    const ubicacion_adjuntos = [];

    if (groups.length > 0) {
        logger.info(`[FASE 3] Extrayendo datos de ${groups.length} adjunto(s) (${config.concurrency} en paralelo)...`);
        const doc = {
            tiffPath,
            numPages,
            pages,
            readPageText: createPageTextReader(tiffPath, pages, transcribedPages)
        };

        await runInOrder({
            from: 0,
            to: groups.length,
            concurrency: config.concurrency,
            work: async index => {
                const { page } = groups[index];
                try {
                    return await extractAdjuntoGroup(groups[index], doc);
                } catch (err) {
                    throwIfInsufficientQuota(err, `OpenAI pagina ${page.pageNum}`);
                    logger.error(`  [ERROR] Pagina ${page.pageNum}/${numPages}: ${err.message}`);
                    errorCount++;
                    return null;
                }
            },
            onResult: entry => {
                if (entry) ubicacion_adjuntos.push(entry);
            }
        });
    }

    const usedPages = new Set(groups.flatMap(({ page, continuation }) => [page, ...continuation].map(p => p.pageIndex)));
    let skippedCount = 0;
    for (let pageIndex = coverPageCount; pageIndex < numPages; pageIndex++) {
        if (!usedPages.has(pageIndex) && !pages[pageIndex]?.error) skippedCount++;
    }
    const successCount = transcribedPages.size;

    // ===================================================================
    // FASE 4: Reporte de codigos no encontrados
    // ===================================================================

    // Una circular SIREFO de una sola pagina puede mencionar instrucciones
    // remitidas por otro sistema sin contenerlas en este TIFF. Conservar esa
    // descripcion en el JSON, pero no exigir un codigo R que nunca se indico.
    const sirefoExternalAdjuntos = extractedData.es_sirefo && numPages === 1
        ? adjuntos.filter(adj => !extractDocCode(adj))
        : [];
    if (sirefoExternalAdjuntos.length > 0) {
        logger.info(`[SIREFO] ${sirefoExternalAdjuntos.length} adjunto(s) descrito(s) sin codigo R en un TIFF de una pagina; se conserva la referencia sin buscar otra pagina.`);
    }

    const notFound = adjuntos.filter(adj => {
        const code = extractDocCode(adj);
        if (sirefoExternalAdjuntos.includes(adj)) return false;
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

    // Cada adjunto incluye la primera página y todas sus continuaciones.
    for (const { page, continuation } of groups) {
        for (const current of [page, ...continuation]) {
            if (!current.text.trim()) continue;
            const label = current === page
                ? `${page.match.code} (confianza: ${(page.match.score * 100).toFixed(0)}%)`
                : `CONTINUACION DE ${page.match.code}`;
            stream.write('-'.repeat(60) + '\n');
            stream.write(`PAGINA ${current.pageNum} / ${numPages} - ${label}\n`);
            stream.write('-'.repeat(60) + '\n');
            stream.write(current.text + '\n\n');
        }
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
    const adjuntosRecuperadosPorAuditoria = ubicacion_adjuntos.filter(a => a.recuperado_por_auditoria);
    const adjuntosConMatchAproximado = ubicacion_adjuntos.filter(a => a._advertencia_match_aproximado);
    const adjuntosConValoresDistintos = ubicacion_adjuntos.filter(a => a._advertencia_valores_distintos);
    const advertencias = [];

    if (adjuntosConError.length > 0) {
        advertencias.push(`${adjuntosConError.length} adjunto(s) con error de extraccion: ${adjuntosConError.map(a => `${a.id_buscado} (${a._error})`).join(', ')}`);
    }
    if (extractedData._error) {
        advertencias.push(`Extraccion de caratula incompleta: ${extractedData._error}`);
    }
    if (codigosNoVerificados.length > 0) {
        advertencias.push(`${codigosNoVerificados.length} codigo(s) R sin confirmacion visual exacta: ${codigosNoVerificados.map(item => item.esperado).join(', ')}`);
    }
    if (paginasDocumentoNoIdentificado.length > 0) {
        advertencias.push(`Posible documento nuevo sin codigo R en pagina(s): ${paginasDocumentoNoIdentificado.map(item => `${item.pagina} (${item.identificador})`).join(', ')}`);
    }
    if (adjuntosRecuperadosPorAuditoria.length > 0) {
        advertencias.push(`${adjuntosRecuperadosPorAuditoria.length} codigo(s) recuperado(s) por auditoria Vision: ${adjuntosRecuperadosPorAuditoria.map(a => a.id_buscado).join(', ')}`);
    }
    if (adjuntosConMatchAproximado.length > 0) {
        advertencias.push(`${adjuntosConMatchAproximado.length} match(es) aproximado(s) requieren revision manual: ${adjuntosConMatchAproximado.map(a => `${a.id_encontrado}->${a.id_buscado}`).join(', ')}`);
    }
    // Solo informativo: juez y juzgado escritos distinto no cambian a quien ni
    // cuanto se retiene, por eso no bloquean el TIFF.
    if (adjuntosConValoresDistintos.length > 0) {
        advertencias.push(`${adjuntosConValoresDistintos.length} adjunto(s) con juez o juzgado escrito distinto entre paginas: ${adjuntosConValoresDistintos.map(a => `${a.id_buscado} (${a._advertencia_valores_distintos.join('; ')})`).join(', ')}`);
    }
    if (sirefoExternalAdjuntos.length > 0) {
        advertencias.push(`${sirefoExternalAdjuntos.length} adjunto(s) SIREFO mencionado(s) sin codigo R y no incluido(s) en este TIFF de una pagina`);
    }
    if (notFound.length > 0) {
        advertencias.push(`${notFound.length} codigo(s) no encontrados en el documento`);
    }
    if (errorCount > 0) {
        advertencias.push(`${errorCount} pagina(s) con errores de procesamiento`);
    }

    const tieneErrores = Boolean(extractedData._error) ||
        adjuntosConError.length > 0 ||
        codigosNoVerificados.length > 0 ||
        paginasDocumentoNoIdentificado.length > 0 ||
        adjuntosConMatchAproximado.length > 0 ||
        notFound.length > 0 ||
        errorCount > 0;

    const falloCritico = Boolean(extractedData._error) || adjuntosConError.length > 0 || notFound.length > 0 || errorCount > 0;
    const estadoProcesamiento = falloCritico
        ? 'error'
        : tieneErrores ? 'requiere_revision' : 'completo';

    // Hash SHA-256 del archivo original para trazabilidad
    let archivoHash = '';
    try {
        archivoHash = await sha256File(tiffPath);
    } catch { /* si falla el hash, no bloquear */ }

    const jsonOutput = {
        archivo_origen: path.basename(tiffPath),
        fecha_procesamiento: now,
        total_paginas: numPages,
        paginas_transcritas: successCount,
        paginas_omitidas: skippedCount,
        tiene_errores: tieneErrores,
        estado_procesamiento: estadoProcesamiento,
        advertencias: advertencias.length > 0 ? advertencias : undefined,
        ...extractedData,
        ubicacion_adjuntos: ubicacion_adjuntos.length > 0 ? ubicacion_adjuntos : undefined,
        codigos_no_encontrados: notFound.length > 0 ? notFound.map(d => extractDocCode(d) || 'SIN_CODIGO') : undefined,
        codigos_no_verificados: codigosNoVerificados.length > 0 ? codigosNoVerificados : undefined,
        paginas_documento_no_identificado: paginasDocumentoNoIdentificado.length > 0 ? paginasDocumentoNoIdentificado : undefined,
        _auditoria: {
            modelo: modelLabel(),
            version_sistema: '2.3.5',
            fecha_iso: new Date().toISOString(),
            hash_archivo_sha256: archivoHash || undefined,
            adjuntos_con_error: adjuntosConError.length > 0 ? adjuntosConError.map(a => a.id_buscado) : undefined,
            adjuntos_recuperados_por_auditoria: adjuntosRecuperadosPorAuditoria.length > 0 ? adjuntosRecuperadosPorAuditoria.map(a => a.id_buscado) : undefined,
            adjuntos_match_aproximado: adjuntosConMatchAproximado.length > 0 ? adjuntosConMatchAproximado.map(a => a.id_buscado) : undefined
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

export function processFile(tiffPath, outputDir) {
    return withOpenAIUsage(path.basename(tiffPath), () => processFileImpl(tiffPath, outputDir));
}
