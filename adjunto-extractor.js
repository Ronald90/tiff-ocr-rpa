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
                            monto: { type: 'string' },
                            moneda: { type: 'string', enum: ['', 'BOB', 'USD', 'UFV'] }
                        },
                        required: [
                            'nombre',
                            'razon_social',
                            'tipo_documento',
                            'nro_documento',
                            'resolucion',
                            'monto',
                            'moneda'
                        ]
                    }
                },
                tipo_proceso: { type: 'string' },
                monto_retenido: { type: 'string' },
                moneda: { type: 'string', enum: ['', 'BOB', 'USD', 'UFV'] },
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
 * Intenta extraer el número de cite del texto transcrito usando patrones regex.
 * Actúa como fallback cuando el modelo no logra identificar el nro_cite.
 * @param {string} ocrText - Texto transcrito del adjunto
 * @returns {string} - Número de cite encontrado o cadena vacía
 */
function extractNroCiteFallback(ocrText) {
    if (!ocrText) return '';

    const patterns = [
        /\bOf\.?\s*(?:N(?:ro)?|No|N[°º])?\.?\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i,
        /\bOficio\s*(?:N(?:ro)?|No|N[°º])?\.?\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i,
        /\bCITE\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i,
        /\b(DSALR\s*[-/\s]\s*[A-Z]{1,6}\s*[-/\s]\s*\d{1,8}(?:\s*\/\s*\d{2,4})?)\b/i,
        /\bN(?:ro)?\.?\s*[:.-]?\s*(\d{1,8}\s*\/\s*\d{4})/i
    ];

    for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match) {
            const normalized = match[1]
                .replace(/\s*([-/])\s*/g, '$1')
                .replace(/\s+/g, ' ')
                .trim()
                .toUpperCase();

            if (/^DSALR\b/.test(normalized) && !normalized.includes('-') && !normalized.includes('/')) {
                return normalized.replace(/\s+/g, '-');
            }

            return normalized.replace(/\s+/g, '');
        }
    }

    return '';
}

function cleanTipoProcesoCandidate(value = '') {
    const cleaned = String(value)
        .replace(/\s+/g, ' ')
        .replace(/^[\s:.;,\-]+/, '')
        .replace(/^(?:tipo\s+de\s+)?proceso\s*[:.-]?\s*/i, '')
        .replace(/^dentro\s+del\s+proceso\s+/i, '')
        .replace(/^proceso\s+de\s+/i, '')
        .replace(/^proceso\s+/i, '')
        .replace(/^(?:ref(?:\.|erencia)?|asunto)\s*[:.-]?\s*/i, '')
        .replace(/^(?:solicita(?:n)?|se\s+solicita|solicitud\s+de)\s+/i, '')
        .replace(/\s+(?:seguido(?:a|o|as|os)?\s+por|contra|exp\.?|nurej\b|cud\b|signado\b|caratulado\b|interpuesto\b|cursante\b|con\s+c\.?i\.?\b|con\s+ci\b).*/i, '')
        .replace(/\s*\(.*$/, '')
        .replace(/[;,.:-]+$/, '')
        .trim();

    if (!cleaned) return '';
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(cleaned)) return '';
    if (cleaned.length > 80) return '';
    return cleaned;
}

/**
 * Limpia el valor devuelto por el modelo sin clasificarlo.
 * @param {string} value
 * @returns {string}
 */
export function normalizeTipoProcesoValue(value = '') {
    return cleanTipoProcesoCandidate(value);
}

function normalizeLooseLine(value = '') {
    return String(value).replace(/\s+/g, ' ').trim();
}

function isSkippableSignatureLine(line = '') {
    const normalized = normalizeLooseLine(line);
    if (!normalized) return true;
    if (/^(?:\[ILEGIBLE\]\s*)+$/i.test(normalized)) return true;
    if (/^\[(?:FIRMA|SELLO ILEGIBLE)\]$/i.test(normalized)) return true;
    return /^[._\-\\/]+$/.test(normalized);
}

function isHonorificOnly(line = '') {
    return /^(?:Dr|Dra|Abog|Abg|Lic|Msc)\.?$/i.test(normalizeLooseLine(line));
}

function cleanJuezCandidate(value = '') {
    const cleaned = normalizeLooseLine(value)
        .replace(/^\[FIRMA\]\s*/i, '')
        .replace(/^(?:nombre\s+del\s+)?juez(?:a)?\s*[:.-]?\s*/i, '')
        .replace(/\s+\bJUEZ(?:A)?\b.*$/i, '')
        .replace(/[;,:.-]+$/, '')
        .trim();

    if (!cleaned) return '';
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(cleaned)) return '';
    if (cleaned.length < 4 || cleaned.length > 100) return '';

    const visibleWords = cleaned
        .replace(/\[ILEGIBLE\]/gi, ' ')
        .replace(/\b(?:Dr|Dra|Abog|Abg|Lic|Msc)\.?\b/gi, ' ')
        .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ'\- ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!visibleWords) return '';
    if (/\d/.test(visibleWords)) return '';

    const forbiddenKeywords = /\b(?:SECRETARI(?:A|O)|VOCAL|OFICIAL|AUXILIAR|TRIBUNAL|JUZGADO|BOLIVIA|PRESENTE|OFICIO|REFERENCIA|REF|EXP|NUREJ|CUD|ASFI|AUTORIDAD|DIRECTOR|PUBLIC[AO]|CIVIL|COMERCIAL|FAMILIA|PENAL|SOCIAL|TRABAJO|PARTIDO|INSTRUCCION)\b/i;
    if (forbiddenKeywords.test(visibleWords)) return '';

    const tokens = visibleWords.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 7) return '';

    return cleaned;
}

function extractJuezCandidateFromLine(line = '') {
    const normalized = normalizeLooseLine(line);
    if (!normalized) return '';

    const labeledMatch = normalized.match(/^juez(?:a)?\s*[:.-]\s*(.+)$/i);
    if (labeledMatch) {
        return cleanJuezCandidate(labeledMatch[1]);
    }

    const inlineMatch = normalized.match(/^(.*?)\s+\bJUEZ(?:A)?\b/i);
    if (inlineMatch && inlineMatch[1].trim()) {
        return cleanJuezCandidate(inlineMatch[1]);
    }

    return '';
}

/**
 * Limpia el valor devuelto por el modelo para juez sin inventar ni clasificar.
 * @param {string} value
 * @returns {string}
 */
export function normalizeJuezValue(value = '') {
    const lines = String(value).split(/\r?\n/).map(normalizeLooseLine).filter(Boolean);

    for (const line of lines) {
        const candidate = extractJuezCandidateFromLine(line);
        if (candidate) return candidate;
    }

    for (const line of lines) {
        const candidate = cleanJuezCandidate(line);
        if (candidate) return candidate;
    }

    return '';
}

/**
 * Fallback conservador para recuperar el nombre del juez desde el bloque de firma
 * o una etiqueta explicita visible en el OCR.
 * @param {string} ocrText - Texto transcrito del adjunto
 * @returns {string}
 */
export function extractJuezFallback(ocrText) {
    if (!ocrText) return '';

    const lines = String(ocrText).split(/\r?\n/).map(normalizeLooseLine).filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const inlineCandidate = extractJuezCandidateFromLine(line);
        if (inlineCandidate) return inlineCandidate;

        if (!/\bJUEZ(?:A)?\b/i.test(line)) {
            continue;
        }

        let honorific = '';

        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
            const previousLine = lines[j];

            if (isSkippableSignatureLine(previousLine)) {
                continue;
            }

            if (isHonorificOnly(previousLine)) {
                honorific = previousLine;
                continue;
            }

            const candidate = cleanJuezCandidate(
                honorific ? `${honorific} ${previousLine}` : previousLine
            );

            if (candidate) {
                return candidate;
            }

            break;
        }
    }

    return '';
}

/**
 * Fallback conservador: solo extrae tipo_proceso cuando el documento trae
 * una mencion explicita de proceso judicial.
 * @param {string} ocrText - Texto transcrito del adjunto
 * @returns {string}
 */
export function extractExplicitTipoProcesoFallback(ocrText) {
    if (!ocrText) return '';

    const lines = ocrText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
        const explicitLabel = line.match(/\b(?:TIPO\s+DE\s+PROCESO|PROCESO)\s*[:.-]\s*(.+)$/i);
        if (explicitLabel) {
            const candidate = cleanTipoProcesoCandidate(explicitLabel[1]);
            if (candidate) return candidate;
        }
    }

    const merged = lines.join(' ');
    const inlinePatterns = [
        /\bdentro\s+del\s+proceso\s+(.+?)(?=\s+(?:seguido(?:a|o|as|os)?\s+por|contra|exp\.?|nurej\b|cud\b|signado\b|caratulado\b|interpuesto\b|cursante\b)|[.;,:]|$)/i,
        /\bproceso\s+de\s+(.+?)(?=\s+(?:seguido(?:a|o|as|os)?\s+por|contra|exp\.?|nurej\b|cud\b|signado\b|caratulado\b|interpuesto\b|cursante\b)|[.;,:]|$)/i
    ];

    for (const pattern of inlinePatterns) {
        const match = merged.match(pattern);
        if (match) {
            const candidate = cleanTipoProcesoCandidate(match[1]);
            if (candidate) return candidate;
        }
    }

    return '';
}

/**
 * Detecta la moneda visible en tablas o menciones de montos del texto transcrito.
 * @param {string} ocrText - Texto transcrito del adjunto
 * @returns {string} - Código de moneda para monto por demandado
 */
function detectDemandadoMontoCurrency(ocrText) {
    if (!ocrText) return '';

    const monetaryWindow = ocrText.match(/(?:MONTO|LIBERAR|RETENER|CONGELAR|EMBARGAR)[\s\S]{0,300}?(Bs\.?|\$us\.?|USD|BOB|UFVs?|bolivianos|d[oó]lares)/i);
    const rawCurrency = monetaryWindow?.[1] || '';

    if (/^\$us\.?$/i.test(rawCurrency) || /^USD$/i.test(rawCurrency) || /^d[oó]lares$/i.test(rawCurrency)) {
        return 'USD';
    }

    if (/^UFVs?$/i.test(rawCurrency)) {
        return 'UFV';
    }

    if (/^Bs\.?$/i.test(rawCurrency) || /^BOB$/i.test(rawCurrency) || /^bolivianos$/i.test(rawCurrency)) {
        return 'BOB';
    }

    const hasBob = /\bBs\.?\b|\bBOB\b|\bbolivianos\b/i.test(ocrText);
    const hasUsd = /\$us\.?|\bUSD\b|\bd[oó]lares\b/i.test(ocrText);
    const hasUfv = /\bUFVs?\b/i.test(ocrText);

    if (hasUfv && !hasBob && !hasUsd) return 'UFV';
    if (hasBob && !hasUsd) return 'BOB';
    if (hasUsd && !hasBob) return 'USD';

    return '';
}

/**
 * Separa moneda y monto por demandado cuando el modelo mezcló ambos valores.
 * @param {string} monto - Monto extraído para un demandado
 * @returns {string} - Monto normalizado
 */
function normalizeDemandadoMonto(monto) {
    if (!monto) return '';
    const trimmed = String(monto).trim();
    if (!trimmed) return '';

    return trimmed
        .replace(/^(?:Bs\.?|BOB|\$us\.?|USD)\s*/i, '')
        .replace(/^(?:UFVs?)\s*/i, '')
        .replace(/\s*(?:Bs\.?|BOB|\$us\.?|USD|UFVs?)$/i, '')
        .replace(/\s*\.-\s*$/i, '')
        .replace(/\s+-\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normaliza la moneda por demandado al mismo formato usado por el campo global.
 * @param {string} moneda - Moneda extraída para un demandado
 * @param {string} fallbackCurrency - Moneda detectada en el texto transcrito
 * @returns {string} - "BOB", "USD", "UFV" o cadena vacía
 */
function normalizeDemandadoMoneda(moneda, fallbackCurrency) {
    const raw = String(moneda || '').trim();

    if (/^\$us\.?$/i.test(raw) || /^USD$/i.test(raw) || /^d[oó]lares$/i.test(raw)) {
        return 'USD';
    }

    if (/^UFVs?$/i.test(raw)) {
        return 'UFV';
    }

    if (/^Bs\.?$/i.test(raw) || /^BOB$/i.test(raw) || /^bolivianos$/i.test(raw)) {
        return 'BOB';
    }

    return fallbackCurrency || '';
}

/**
 * Garantiza que el resultado tenga todos los campos esperados.
 * @param {object} data - Datos crudos del modelo
 * @param {string} [ocrText] - Texto transcrito original para respaldos de normalización
 * @returns {object} - Resultado normalizado
 */
function normalizeAdjuntoResult(data, ocrText = '') {
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

    const demandadoMontoCurrency = detectDemandadoMontoCurrency(ocrText);
    result.tipo_proceso = normalizeTipoProcesoValue(result.tipo_proceso);
    if (!result.tipo_proceso) {
        result.tipo_proceso = extractExplicitTipoProcesoFallback(ocrText);
    }
    result.juez = normalizeJuezValue(result.juez);
    if (!result.juez) {
        result.juez = extractJuezFallback(ocrText);
    }
    result.moneda = normalizeDemandadoMoneda(
        result.moneda,
        result.monto_retenido ? detectDemandadoMontoCurrency(ocrText) : ''
    );

    // Normalizar cada demandado
    result.demandados = result.demandados.map(d => ({
        nombre: d.nombre || '',
        razon_social: d.razon_social || '',
        tipo_documento: d.tipo_documento || '',
        nro_documento: d.nro_documento || '',
        resolucion: d.resolucion || '',
        monto: normalizeDemandadoMonto(d.monto),
        moneda: normalizeDemandadoMoneda(d.moneda, demandadoMontoCurrency)
    }));

    return result;
}

/**
 * Extrae campos estructurados del texto transcrito de un documento adjunto.
 * Identifica cite, demandados, montos, juez, juzgado, etc.
 * @param {string} ocrText - Texto transcrito del documento adjunto
 * @returns {Promise<object>} - Campos extraidos
 */
export async function extractAdjuntoFields(ocrText) {
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
        const model = modelForAttempt(attempt);

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

            const normalized = normalizeAdjuntoResult(parsed, truncated);
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
