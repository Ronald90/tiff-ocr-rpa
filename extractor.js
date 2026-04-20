import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import { sleep, renderPrompt, modelForAttempt, safeJsonParse } from './utils.js';

const MAX_EXTRACT_CHARS = 8000;

const EMPTY_RESULT = {
    tipo_documento: '',
    documento: '',
    denominacion: '',
    ciudad: '',
    departamento: '',
    fecha: '',
    destinatario: '',
    referencia: '',
    numero_tramite: '',
    es_sirefo: false,
    para_conocimiento: [],
    documentos_adjuntos: [],
    modificaciones: []
};

const CARATULA_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'caratula_extraction',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                tipo_documento: { type: 'string' },
                documento: { type: 'string' },
                denominacion: { type: 'string' },
                ciudad: { type: 'string' },
                departamento: { type: 'string' },
                fecha: { type: 'string' },
                destinatario: { type: 'string' },
                referencia: { type: 'string' },
                numero_tramite: { type: 'string' },
                es_sirefo: { type: 'boolean' },
                para_conocimiento: {
                    type: 'array',
                    items: { type: 'string' }
                },
                documentos_adjuntos: {
                    type: 'array',
                    items: { type: 'string' }
                },
                modificaciones: {
                    type: 'array',
                    items: { type: 'string' }
                }
            },
            required: [
                'tipo_documento',
                'documento',
                'denominacion',
                'ciudad',
                'departamento',
                'fecha',
                'destinatario',
                'referencia',
                'numero_tramite',
                'es_sirefo',
                'para_conocimiento',
                'documentos_adjuntos',
                'modificaciones'
            ]
        }
    }
};

// Cargar prompts desde archivos externos
const EXTRACTION_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_caratula.txt'), 'utf-8');
const EXTRACTION_USER_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_caratula_user.txt'), 'utf-8');

/**
 * Garantiza que el resultado tenga todos los campos esperados
 * @param {object} data - Datos crudos del modelo
 * @returns {object} - Resultado normalizado con todos los campos
 */
function normalizeResult(data) {
    const result = { ...EMPTY_RESULT };

    if (!data || typeof data !== 'object') {
        return result;
    }

    // Asegurarse de que campos de listas sean arrays
    const listFields = ['para_conocimiento', 'documentos_adjuntos', 'modificaciones'];
    for (const field of listFields) {
        if (data[field] === undefined || data[field] === null || data[field] === '') {
            result[field] = [];
        } else if (Array.isArray(data[field])) {
            result[field] = data[field];
        } else if (typeof data[field] === 'string') {
            result[field] = [data[field]];
        }
    }

    for (const key of Object.keys(result)) {
        if (listFields.includes(key)) continue;
        if (data[key] !== undefined && data[key] !== null) {
            result[key] = data[key];
        }
    }

    return result;
}

/**
 * Extrae campos estructurados de la caratula transcrita por Vision.
 * @param {string} ocrText - Texto transcrito de la caratula
 * @returns {Promise<object>} - Campos extraidos normalizados
 */
export async function extractFields(ocrText) {
    if (!ocrText || ocrText.trim().length < 50) {
        logger.warn('[EXTRACT] Texto de caratula demasiado corto para extraer campos');
        return { ...EMPTY_RESULT };
    }

    const truncated = ocrText.length > MAX_EXTRACT_CHARS
        ? ocrText.substring(0, MAX_EXTRACT_CHARS) + '\n\n[... texto restante omitido ...]'
        : ocrText;

    logger.info(`[EXTRACT] Procesando caratula (${truncated.length} chars de ${ocrText.length} total)`);

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const model = modelForAttempt(attempt);

        try {
            const response = await openai.chat.completions.create({
                model,
                max_completion_tokens: 6000,
                response_format: CARATULA_RESPONSE_FORMAT,
                messages: [
                    {
                        role: 'system',
                        content: EXTRACTION_PROMPT
                    },
                    {
                        role: 'user',
                        content: renderPrompt(EXTRACTION_USER_PROMPT, { text: truncated })
                    }
                ]
            });

            const raw = response.choices[0].message.content.trim();
            const parsed = safeJsonParse(raw);

            if (!parsed) {
                throw new Error('JSON invalido devuelto por el modelo');
            }

            const normalized = normalizeResult(parsed);
            logger.success(`[EXTRACT] Campos de caratula extraidos correctamente con ${model}`);
            return normalized;
        } catch (err) {
            const isRateLimit = err.status === 429;

            if (attempt < config.maxRetries) {
                const waitTime = isRateLimit
                    ? config.retryDelayMs * attempt * 2
                    : config.retryDelayMs;

                logger.warn(`[EXTRACT] Reintento ${attempt}/${config.maxRetries} con ${model} - ${err.message}`);
                await sleep(waitTime);
            } else {
                logger.error(`[EXTRACT] Fallo despues de ${config.maxRetries} intentos con ${model}: ${err.message}`);
                return {
                    ...EMPTY_RESULT,
                    _error: err.message
                };
            }
        }
    }

    // Fallback defensivo: si maxRetries es 0 o el loop no devuelve nada
    return { ...EMPTY_RESULT, _error: 'Sin intentos disponibles' };
}
