import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import { sleep, renderPrompt, modelForAttempt, safeJsonParse } from './utils.js';

const ADJUNTO_EMPTY = {
    nro_cite: '',
    fecha_cite: '',
    ciudad_cite: '',
    demandante: '',
    demandados: [],
    tipo_proceso: '',
    monto_retenido: '',
    moneda: '',
    tipo_documento_respaldo: '',
    nro_documento_respaldo: '',
    juez: '',
    juzgado: ''
};

const ADJUNTO_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'adjunto_extraction',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                nro_cite: { type: 'string' },
                fecha_cite: { type: 'string' },
                ciudad_cite: { type: 'string' },
                demandante: { type: 'string' },
                demandados: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            nombre: { type: 'string' },
                            razon_social: { type: 'string' },
                            tipo_documento: { type: 'string' },
                            nro_documento: { type: 'string' },
                            resolucion: { type: 'string' },
                            monto: { type: 'string' }
                        },
                        required: [
                            'nombre',
                            'razon_social',
                            'tipo_documento',
                            'nro_documento',
                            'resolucion',
                            'monto'
                        ]
                    }
                },
                tipo_proceso: { type: 'string' },
                monto_retenido: { type: 'string' },
                moneda: { type: 'string' },
                tipo_documento_respaldo: { type: 'string' },
                nro_documento_respaldo: { type: 'string' },
                juez: { type: 'string' },
                juzgado: { type: 'string' }
            },
            required: [
                'nro_cite',
                'fecha_cite',
                'ciudad_cite',
                'demandante',
                'demandados',
                'tipo_proceso',
                'monto_retenido',
                'moneda',
                'tipo_documento_respaldo',
                'nro_documento_respaldo',
                'juez',
                'juzgado'
            ]
        }
    }
};

// Cargar prompts desde archivos externos
const ADJUNTO_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_adjunto.txt'), 'utf-8');
const ADJUNTO_USER_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_adjunto_user.txt'), 'utf-8');

/**
 * Intenta extraer el número de cite del texto OCR usando patrones regex.
 * Actúa como fallback cuando el modelo no logra identificar el nro_cite.
 * @param {string} ocrText - Texto OCR del adjunto
 * @returns {string} - Número de cite encontrado o cadena vacía
 */
function extractNroCiteFallback(ocrText) {
    if (!ocrText) return '';

    const patterns = [
        /\bOf\.?\s*(?:N(?:ro)?|No|N[°º])?\.?\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i,
        /\bOficio\s*(?:N(?:ro)?|No|N[°º])?\.?\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i,
        /\bCITE\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i,
        /\bN(?:ro)?\.?\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i
    ];

    for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match) {
            return match[1].replace(/\s+/g, '');
        }
    }

    return '';
}

/**
 * Garantiza que el resultado tenga todos los campos esperados.
 * @param {object} data - Datos crudos del modelo
 * @returns {object} - Resultado normalizado
 */
function normalizeAdjuntoResult(data) {
    const result = { ...ADJUNTO_EMPTY };

    if (!data || typeof data !== 'object') {
        return result;
    }

    for (const key of Object.keys(result)) {
        if (data[key] !== undefined && data[key] !== null) {
            result[key] = data[key];
        }
    }

    if (!Array.isArray(result.demandados)) {
        result.demandados = [];
    }

    // Normalizar cada demandado
    result.demandados = result.demandados.map(d => ({
        nombre: d.nombre || '',
        razon_social: d.razon_social || '',
        tipo_documento: d.tipo_documento || '',
        nro_documento: d.nro_documento || '',
        resolucion: d.resolucion || '',
        monto: d.monto || ''
    }));

    return result;
}

/**
 * Extrae campos estructurados del texto OCR de un documento adjunto.
 * Identifica cite, demandados, montos, juez, juzgado, etc.
 * @param {string} ocrText - Texto OCR del documento adjunto
 * @param {object} [options] - Opciones de extracción
 * @param {string} [options.model] - Modelo forzado a usar
 * @returns {Promise<object>} - Campos extraidos
 */
export async function extractAdjuntoFields(ocrText, options = {}) {
    if (!ocrText || ocrText.trim().length < 50) {
        logger.warn('[ADJUNTO-EXTRACT] Texto demasiado corto para extraer campos');
        return { ...ADJUNTO_EMPTY };
    }

    // Limitar texto sin cortar demasiado los datos de demandados o cuentas.
    // Tablas con 50+ contribuyentes pueden generar texto extenso.
    const maxChars = 24000;
    const truncated = ocrText.length > maxChars
        ? ocrText.substring(0, maxChars) + '\n\n[... texto restante omitido ...]'
        : ocrText;

    logger.info(`[ADJUNTO-EXTRACT] Extrayendo campos del adjunto (${truncated.length} chars)...`);

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const model = modelForAttempt(attempt, options.model);

        try {
            const response = await openai.chat.completions.create({
                model,
                max_completion_tokens: 16000,
                response_format: ADJUNTO_RESPONSE_FORMAT,
                messages: [
                    {
                        role: 'system',
                        content: ADJUNTO_PROMPT
                    },
                    {
                        role: 'user',
                        content: renderPrompt(ADJUNTO_USER_PROMPT, { text: truncated })
                    }
                ]
            });

            const raw = response.choices[0].message.content.trim();
            const parsed = safeJsonParse(raw);

            if (!parsed) {
                throw new Error('JSON invalido devuelto por el modelo');
            }

            const normalized = normalizeAdjuntoResult(parsed);
            if (!normalized.nro_cite) {
                const fallbackNroCite = extractNroCiteFallback(truncated);
                if (fallbackNroCite) {
                    normalized.nro_cite = fallbackNroCite;
                    logger.info(`[ADJUNTO-EXTRACT] nro_cite recuperado por regex: ${fallbackNroCite}`);
                }
            }

            logger.success(`[ADJUNTO-EXTRACT] Campos del adjunto extraidos correctamente con ${model}`);
            return normalized;

        } catch (err) {
            const isRateLimit = err.status === 429;

            if (attempt < config.maxRetries) {
                const waitTime = isRateLimit
                    ? config.retryDelayMs * attempt * 2
                    : config.retryDelayMs;

                logger.warn(
                    `[ADJUNTO-EXTRACT] Reintento ${attempt}/${config.maxRetries} con ${model} - ${err.message}`
                );
                await sleep(waitTime);
            } else {
                logger.error(
                    `[ADJUNTO-EXTRACT] Fallo despues de ${config.maxRetries} intentos con ${model}: ${err.message}`
                );
                return {
                    ...ADJUNTO_EMPTY,
                    _error: err.message
                };
            }
        }
    }

    // Fallback defensivo: si maxRetries es 0 o el loop no devuelve nada
    return { ...ADJUNTO_EMPTY, _error: 'Sin intentos disponibles' };
}
