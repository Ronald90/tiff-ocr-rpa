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
                tipo_proceso: {
                    type: 'string',
                    enum: ['', 'Retencion', 'Suspension', 'Remision', 'Certificacion', 'Informe', 'Revision']
                },
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

/**
 * Clasifica el tipo de proceso en una etiqueta corta.
 * @param {string} text - Texto a clasificar
 * @returns {string} - Tipo de proceso corto o cadena vacía
 */
function classifyTipoProceso(text) {
    if (!text) return '';

    const normalized = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    if (/\b(remision|remita|remitir|transfiera|transferir|transferencia)\b/.test(normalized)) {
        return 'Remision';
    }

    if (/\b(certifique|certificacion|certificar|certificado)\b/.test(normalized) || /informe\s+(?:el\s+)?monto\s+retenido/.test(normalized)) {
        return 'Certificacion';
    }

    if (/\b(revise|revision|actualice|actualizacion|verifique|verificacion)\b/.test(normalized)) {
        return 'Revision';
    }

    if (/informe\s+(?:si\s+)?(?:tiene|mantiene|posee)\s+cuentas/.test(normalized) || /\b(detalle|detallar)\s+de\s+movimientos\b/.test(normalized)) {
        return 'Informe';
    }

    if (/\b(suspension|suspender|cancele|cancelacion|cancelar|liberacion|liberar|descongelamiento|descongelar)\b/.test(normalized) || /dejar\s+sin\s+efecto\s+.*retencion/.test(normalized)) {
        return 'Suspension';
    }

    if (/\b(retencion|retener|congelamiento|congelar|inmovilizacion|inmovilizar|embargo|embargar)\b/.test(normalized)) {
        return 'Retencion';
    }

    return '';
}

/**
 * Extrae y clasifica el tipo de proceso desde referencias tipo REF/SOLICITA o desde el cuerpo.
 * @param {string} ocrText - Texto transcrito del adjunto
 * @returns {string} - Tipo de proceso corto o cadena vacía
 */
function extractTipoProcesoFallback(ocrText) {
    if (!ocrText) return '';

    const fullTextClassification = classifyTipoProceso(ocrText);
    if (fullTextClassification) return fullTextClassification;

    const cleanProcess = (value) => value
        .replace(/\s+/g, ' ')
        .replace(/^[:.;,\-\s]+/, '')
        .replace(/^(?:SOLICITA|SOLICITAN|SOLICITUD\s+DE|SE\s+SOLICITA|PIDE|REQUIERE)\s+/i, '')
        .trim();

    const lines = ocrText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
        const refMatch = lines[i].match(/\bREF(?:\.|ERENCIA)?\s*[:.-]\s*(.+)$/i);
        if (!refMatch) continue;

        const parts = [refMatch[1]];
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
            if (/^(?:de nuestra consideracion|mediante|señor|senor|presente|atentamente)\b/i.test(lines[j])) break;
            if (/^(?:y\s+)?(?:fondos|cuentas|bancarias|safi|retencion|suspension)\b/i.test(lines[j]) || /^[A-ZÁÉÍÓÚÑ0-9\s.,;:-]+$/.test(lines[j])) {
                parts.push(lines[j]);
            } else {
                break;
            }
        }

        const value = cleanProcess(parts.join(' '));
        const classified = classifyTipoProceso(value);
        if (classified) return classified;
    }

    const patterns = [
        /\b(?:SOLICITA|SOLICITAN|SE\s+SOLICITA)\s+((?:SUSPENSI[OÓ]N|SUSPENSION|RETENCI[OÓ]N|RETENCION|CONGELAMIENTO|EMBARGO)[^\n.]{10,180})/i,
        /\bsolicitar\s+la\s+((?:SUSPENSI[OÓ]N|SUSPENSION|RETENCI[OÓ]N|RETENCION|CONGELAMIENTO|EMBARGO)[^\n.]{10,180})/i,
        /\b((?:SUSPENSI[OÓ]N|SUSPENSION)\s+DE\s+(?:RETENCI[OÓ]N|RETENCION)[^\n.]{10,180})/i,
        /\b((?:RETENCI[OÓ]N|RETENCION)\s+DE\s+FONDOS[^\n.]{0,180})/i,
        /\b(CONGELAMIENTO\s+DE\s+CUENTAS[^\n.]{0,180})/i
    ];

    for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match) {
            const classified = classifyTipoProceso(cleanProcess(match[1]));
            if (classified) return classified;
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
    result.tipo_proceso = classifyTipoProceso(result.tipo_proceso) || classifyTipoProceso(ocrText) || '';
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

            const fallbackTipoProceso = extractTipoProcesoFallback(truncated);
            if (fallbackTipoProceso && normalized.tipo_proceso !== fallbackTipoProceso) {
                normalized.tipo_proceso = fallbackTipoProceso;
                logger.info(`[ADJUNTO-EXTRACT] tipo_proceso clasificado: ${fallbackTipoProceso}`);
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
