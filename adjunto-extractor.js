import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

// Cargar prompts desde archivos externos
const ADJUNTO_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_adjunto.txt'), 'utf-8');
const ADJUNTO_USER_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_adjunto_user.txt'), 'utf-8');

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


/**
 * Garantiza que el resultado tenga todos los campos esperados
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
        nro_documento: d.nro_documento || ''
    }));

    return result;
}


/**
 * Extrae JSON incluso si el modelo devuelve texto extra
 */
function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch {
                return null;
            }
        }
        return null;
    }
}


/**
 * Extrae campos estructurados del texto OCR de un documento adjunto.
 * Identifica cite, demandados, montos, juez, juzgado, etc.
 * @param {string} ocrText - Texto OCR del documento adjunto
 * @returns {object} - Campos extraidos
 */
export async function extractAdjuntoFields(ocrText) {
    if (!ocrText || ocrText.trim().length < 50) {
        logger.warn('[ADJUNTO-EXTRACT] Texto demasiado corto para extraer campos');
        return { ...ADJUNTO_EMPTY };
    }

    // Limitar texto para ahorrar tokens (los datos clave estan al inicio)
    const maxChars = 6000;
    const truncated = ocrText.length > maxChars
        ? ocrText.substring(0, maxChars) + '\n\n[... texto restante omitido ...]'
        : ocrText;

    logger.info(`[ADJUNTO-EXTRACT] Extrayendo campos del adjunto (${truncated.length} chars)...`);

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            const response = await openai.chat.completions.create({
                model: config.model,
                temperature: 0,
                max_tokens: 1000,
                response_format: { type: 'json_object' },
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

            logger.success('[ADJUNTO-EXTRACT] Campos del adjunto extraidos correctamente');
            return normalized;

        } catch (err) {
            const isRateLimit = err.status === 429;

            if (attempt < config.maxRetries) {
                const waitTime = isRateLimit
                    ? config.retryDelayMs * attempt * 2
                    : config.retryDelayMs;

                logger.warn(
                    `[ADJUNTO-EXTRACT] Reintento ${attempt}/${config.maxRetries} - ${err.message}`
                );
                await sleep(waitTime);
            } else {
                logger.error(
                    `[ADJUNTO-EXTRACT] Fallo despues de ${config.maxRetries} intentos: ${err.message}`
                );
                return {
                    ...ADJUNTO_EMPTY,
                    _error: err.message
                };
            }
        }
    }
}
