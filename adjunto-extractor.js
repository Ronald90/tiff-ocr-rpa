import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';
import { isRetryableOpenAIError, throwIfInsufficientQuota, TruncatedOutputError } from './openai-errors.js';
import { sleep, renderPrompt, modelForAttempt, safeJsonParse } from './utils.js';

const ADJUNTO_MAX_OUTPUT_TOKENS = 16000;

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

const CONTINUATION_FIELDS = [
    'demandados', 'juez', 'juzgado', 'tipo_documento_respaldo',
    'nro_documento_respaldo', 'monto_retenido', 'moneda'
];

const ADJUNTO_CONTINUATION_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'adjunto_continuacion',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(CONTINUATION_FIELDS.map(key => [
                key, ADJUNTO_RESPONSE_FORMAT.json_schema.schema.properties[key]
            ])),
            required: CONTINUATION_FIELDS
        }
    }
};

// Cargar prompts desde archivos externos
const ADJUNTO_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_adjunto.txt'), 'utf-8');
const ADJUNTO_USER_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_adjunto_user.txt'), 'utf-8');
const ADJUNTO_CONTINUATION_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_adjunto_continuacion.txt'), 'utf-8');

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

function isLikelyNonNamePhrase(value = '') {
    const text = normalizeLooseLine(value);
    if (!text) return true;

    const visibleWords = text
        .replace(/\[ILEGIBLE\]/gi, ' ')
        .replace(/\b(?:Dr|Dra|Abog|Abg|Lic|Msc)\.?\b/gi, ' ')
        .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ'\- ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!visibleWords) return true;

    const legalNonNameKeywords = /\b(?:NO\s+ENCONTRADO|POR\s+TANTO|SUSCRIT[AO]|FIRMA|SELLO|VEJEZ|INVALIDEZ|PENSION(?:ES)?|JUBILACI(?:O|Ó)N(?:ES)?|MONTEP(?:I|Í)O(?:S)?|RENTA(?:S)?|SUELDO(?:S)?|SALARIO(?:S)?|CUENTA(?:S)?|CONVENIO|PAGO|RETENCI(?:O|Ó)N|SUSPENSI(?:O|Ó)N|FONDO(?:S)?|MONTO|LITERAL|NUMERAL|BOLIVIANO(?:S)?|PROCESO|DEMANDANTE|DEMANDADO(?:S)?|EMPRESA|ASOCIACI(?:O|Ó)N|CONSTRUCTORA|CONSULTORA|SERVICIO(?:S)?|INGENIERIA|AMBIENTE|GOBIERNO|AUTONOMO)\b/i;
    if (legalNonNameKeywords.test(visibleWords)) return true;

    const tokens = visibleWords.split(/\s+/).filter(Boolean);
    const connectorTokens = tokens.filter(token => /^(?:DE|DEL|LA|LAS|LOS|EL|Y|O|E)$/i.test(token));

    if (/^(?:DE|DEL|LA|LAS|LOS|EL|Y|O|E)\b/i.test(visibleWords)) return true;
    if (tokens.length > 0 && connectorTokens.length / tokens.length > 0.45) return true;

    return false;
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
    if (/\d/.test(cleaned)) return '';

    const visibleWords = cleaned
        .replace(/\[ILEGIBLE\]/gi, ' ')
        .replace(/\b(?:Dr|Dra|Abog|Abg|Lic|Msc)\.?\b/gi, ' ')
        .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ'\- ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!visibleWords) return '';
    if (isLikelyNonNamePhrase(visibleWords)) return '';

    const forbiddenKeywords = /\b(?:PAGINA|SEÑOR(?:A)?|SENOR(?:A)?|SECRETARI(?:A|O)|VOCAL|OFICIAL|AUXILIAR|TRIBUNAL|JUZGADO|BOLIVIA|PRESENTE|OFICIO|REFERENCIA|REF|EXP|NUREJ|CUD|ASFI|AUTORIDAD|DIRECTOR|PUBLIC[AO]|CIVIL|COMERCIAL|FAMILIA|PENAL|SOCIAL|TRABAJO|PARTIDO|INSTRUCCION|ADMINISTRATIV[AO]|COACTIV[AO]|FISCAL|TRIBUTARI[AO]|CAPITAL)\b/i;
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

        // "SEÑOR JUEZ" en el encabezado es el destinatario, no una firma.
        if (!/^JUEZ(?:A)?\b/i.test(line)) {
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
 * @returns {string} - "BOB", "USD", "UFV" o cadena vacía
 */
function normalizeDemandadoMoneda(moneda) {
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

    result.tipo_proceso = normalizeTipoProcesoValue(result.tipo_proceso);
    result.juez = normalizeJuezValue(result.juez);
    result.moneda = normalizeDemandadoMoneda(result.moneda);

    // Normalizar cada demandado y filtrar los que no tienen identificador
    result.demandados = result.demandados
        .map(d => ({
            nombre: d.nombre || '',
            razon_social: d.razon_social || '',
            tipo_documento: d.tipo_documento || '',
            nro_documento: d.nro_documento || '',
            resolucion: d.resolucion || '',
            monto: normalizeDemandadoMonto(d.monto),
            moneda: normalizeDemandadoMoneda(d.moneda)
        }))
        .filter(d => d.nombre || d.razon_social || d.nro_documento);

    return result;
}

/**
 * Completa solo desde la pagina principal los campos que el modelo dejo vacios.
 * Un oficio o resolucion adjunta no puede aportar datos del documento R. El
 * juez se completa aparte, despues de leer las continuaciones.
 * @param {object} result - Resultado normalizado (se modifica)
 * @param {string} ocrText - Texto transcrito de la pagina principal
 */
function applyTextFallbacks(result, ocrText) {
    if (!result.tipo_proceso) {
        result.tipo_proceso = extractExplicitTipoProcesoFallback(ocrText);
    }
    if (!result.moneda && result.monto_retenido) {
        result.moneda = detectDemandadoMontoCurrency(ocrText);
    }
    if (!result.nro_cite) {
        const fallbackNroCite = extractNroCiteFallback(ocrText);
        if (fallbackNroCite) {
            result.nro_cite = fallbackNroCite;
            logger.info(`[ADJUNTO-EXTRACT] nro_cite recuperado por regex: ${fallbackNroCite}`);
        }
    }
}

const DOCUMENT_MONTHS = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
};
const MONTH_NAMES = Object.keys(DOCUMENT_MONTHS).join('|');
const CLOSING_DATE_LINE = new RegExp(
    `^\\s*([\\p{L}][\\p{L}\\s.-]{2,60})\\s*,\\s*(?:(\\d{1,2})\\s+(?:de\\s+)?(${MONTH_NAMES})|(${MONTH_NAMES}))\\s+(?:de|del)\\s+(\\d{4})\\.?\\s*$`,
    'iu'
);

/** Una actuación nueva puede compartir TIFF y proceso, pero tiene otra fecha propia. */
function beginsSeparateAct(text) {
    const heading = text.split('\n').slice(0, 35).join('\n');
    return /^\s*(?:SENTENCIA\s+INICIAL|AUTO\s+INTERLOCUTORIO|RESOLUCI[OÓ]N\s+(?:N[O°º.]|ADMINISTRATIVA)|NOTIFICACI[OÓ]N\s+PROCESAL)\b/im.test(heading);
}

/** Solo una fecha de cierre, próxima a la firma, pertenece al memorial principal. */
function findClosingPlaceDate(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(CLOSING_DATE_LINE);
        if (!match || !/\[FIRMA\]|\bFDO\.?\b/i.test(lines.slice(i + 1, i + 8).join('\n'))) continue;

        const city = match[1].trim();
        const day = Number(match[2]);
        if (!match[2]) return { city, date: '' };

        const month = DOCUMENT_MONTHS[match[3].toLowerCase()];
        const year = Number(match[5]);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
            return { city, date: '' };
        }
        return { city, date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
    return null;
}

/** Busca solo un cite explícito al comienzo de una continuación del memorial. */
function findContinuationCite(text) {
    const header = text.split('\n').slice(0, 18);
    for (const line of header) {
        if (!/^\s*(?:OF\.?\s*N|OFICIO\s*N|CITE\s*[:.-]|DSALR\s*[-/])/i.test(line)) continue;
        const cite = extractNroCiteFallback(line);
        if (cite) return cite;
    }
    return '';
}

/** Completa campos vacíos con continuaciones anteriores al primer documento de respaldo. */
function applyContinuationMetadataFallback(result, continuationTexts = []) {
    if (result.nro_cite && result.fecha_cite && result.ciudad_cite) return;

    for (const text of continuationTexts) {
        if (beginsSeparateAct(text)) break;

        if (!result.nro_cite) result.nro_cite = findContinuationCite(text);

        const closing = findClosingPlaceDate(text);
        if (!closing) continue;

        if (!result.fecha_cite && closing.date &&
            (!result.ciudad_cite || sameFieldValue(result.ciudad_cite, closing.city))) {
            result.fecha_cite = closing.date;
        }
        if (!result.ciudad_cite && closing.city &&
            (!result.fecha_cite || !closing.date || result.fecha_cite === closing.date)) {
            result.ciudad_cite = closing.city;
        }
        break;
    }
}

/** Compara valores repetidos sin diferencias de mayusculas, tildes o espacios. */
function sameFieldValue(a, b) {
    const canonical = value => String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
    return canonical(a) === canonical(b);
}

/** Los espacios de OCR dentro de un NUREJ/CUD no cambian sus caracteres. */
function sameProcessNumber(a, b) {
    const canonical = value => String(value).replace(/\s+/g, '').toUpperCase();
    return Boolean(canonical(a)) && canonical(a) === canonical(b);
}

/** La puntuación de una sigla comercial no cambia la razón social. */
function sameCorporateName(a, b) {
    const canonical = value => String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
    return Boolean(canonical(a)) && canonical(a) === canonical(b);
}

function courtNumber(value) {
    const text = String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    const digit = text.match(/\b([1-9]|1\d|20)(?!\d)\s*(?:[º°ª]|RO\b|DO\b|TO\b|VO\b)?/);
    if (digit) return Number(digit[1]);
    const ordinals = [
        'PRIMERO', 'SEGUNDO', 'TERCERO', 'CUARTO', 'QUINTO', 'SEXTO',
        'SEPTIMO', 'OCTAVO', 'NOVENO', 'DECIMO', 'UNDECIMO', 'DUODECIMO',
        'DECIMO TERCERO', 'DECIMO CUARTO', 'DECIMO QUINTO', 'DECIMO SEXTO',
        'DECIMO SEPTIMO', 'DECIMO OCTAVO', 'DECIMO NOVENO', 'VIGESIMO'
    ];
    const found = ordinals
        .map((ordinal, index) => ({ ordinal, number: index + 1 }))
        .sort((left, right) => right.ordinal.length - left.ordinal.length)
        .find(({ ordinal }) => new RegExp(`\\b${ordinal}\\b`).test(text));
    return found?.number || null;
}

function courtAreas(value) {
    const text = String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    return ['CIVIL', 'COMERCIAL', 'FAMILIA', 'PENAL', 'TRABAJO', 'SOCIAL']
        .filter(area => new RegExp(`\\b${area}\\b`).test(text));
}

function sameJudgePronunciation(a, b) {
    const tokens = value => String(value)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().replace(/^(?:ABG|ABOG|DR|DRA|LIC)\.?\s+/, '')
        .match(/[A-ZÑ]+/g) || [];
    const left = tokens(a);
    const right = tokens(b);
    if (left.length < 3 || left.length !== right.length) return false;
    if (left.slice(1).some((part, index) => part !== right[index + 1])) return false;
    const phonetic = name => name.replace(/C(?=[EI])/g, 'S').replace(/(.)\1+/g, '$1');
    return phonetic(left[0]) === phonetic(right[0]);
}

/** Compara grafías de una autoridad; un ordinal distinto sigue siendo conflicto. */
function sameAuthorityValue(field, a, b) {
    const canonical = value => {
        let text = String(value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/^(?:ABG|ABOG|DR|DRA|LIC)\.?\s+/, '');
        if (field === 'juzgado') {
            const ordinals = ['PRIMERO', 'SEGUNDO', 'TERCERO', 'CUARTO', 'QUINTO', 'SEXTO', 'SEPTIMO', 'OCTAVO', 'NOVENO', 'DECIMO'];
            for (const [index, ordinal] of ordinals.entries()) {
                text = text.replace(new RegExp(`\\b${ordinal.replace(/O$/, '[OA]')}\\b`, 'g'), String(index + 1));
            }
            text = text.replace(/(\d)[º°ª]/g, '$1').replace(/\bY\b/g, ' ');
        }
        return text.replace(/[^A-Z0-9Ñ]+/g, ' ').trim().replace(/\s+/g, ' ');
    };
    if (canonical(a) === canonical(b)) return true;
    if (field === 'juez') return sameJudgePronunciation(a, b);
    if (field !== 'juzgado') return false;
    const leftNumber = courtNumber(a);
    const rightNumber = courtNumber(b);
    if (leftNumber && rightNumber && leftNumber !== rightNumber) return false;
    const leftAreas = courtAreas(a);
    const rightAreas = courtAreas(b);
    const sameArea = leftAreas.length > 0 && rightAreas.length > 0 &&
        leftAreas.some(area => rightAreas.includes(area));
    if (!sameArea) return false;
    if (!leftNumber && !rightNumber) return /\[ILEGIBLE\]/i.test(a) || /\[ILEGIBLE\]/i.test(b);
    return true;
}

/** Lleva un monto a "entero.decimales" ("Bs. 1.000,00", "1000" y "1.000.oo" coinciden). */
function canonicalAmount(value) {
    const text = normalizeDemandadoMonto(value).replace(/[oO]{2}$/, '00').replace(/\s/g, '');
    if (!/^\d[\d.,]*$/.test(text)) return null;
    const decimals = text.match(/[.,](\d{1,2})$/);
    const integer = (decimals ? text.slice(0, decimals.index) : text).replace(/[.,]/g, '');
    return `${Number(integer)}.${(decimals?.[1] || '0').padEnd(2, '0')}`;
}

/** Compara montos por su valor; los que no son numéricos, como texto. */
function sameAmount(a, b) {
    const left = canonicalAmount(a);
    const right = canonicalAmount(b);
    return left !== null && right !== null ? left === right : sameFieldValue(a, b);
}

/** Une menciones de la misma persona sin perder datos ni ocultar diferencias reales. */
function mergeDemandados(demandados) {
    const rows = [];
    const conflictingFields = new Set();
    for (const candidate of demandados) {
        const candidateName = candidate.razon_social || candidate.nombre;
        const matches = rows.filter(row => {
            // La misma persona con otra resolucion es otra fila de la orden
            // (por ejemplo, varias resoluciones tributarias del mismo NIT).
            if (row.resolucion && candidate.resolucion && !sameFieldValue(row.resolucion, candidate.resolucion)) {
                return false;
            }
            const rowName = row.razon_social || row.nombre;
            const bothIds = row.nro_documento && candidate.nro_documento;
            if (bothIds) {
                return sameFieldValue(row.nro_documento, candidate.nro_documento) &&
                    (!row.tipo_documento || !candidate.tipo_documento || sameFieldValue(row.tipo_documento, candidate.tipo_documento));
            }
            return rowName && candidateName && sameFieldValue(rowName, candidateName);
        });
        let existing = matches.length === 1 ? matches[0] : null;
        if (matches.length > 1) {
            // Una fila sin resolución no pertenece necesariamente a la primera
            // resolución de esa persona. El monto solo desambigua si coincide
            // con exactamente una fila ya identificada.
            const byResolution = candidate.resolucion
                ? matches.filter(row => row.resolucion && sameFieldValue(row.resolucion, candidate.resolucion))
                : matches;
            const choices = byResolution.length > 0 ? byResolution : matches;
            const byAmount = candidate.monto
                ? choices.filter(row => row.monto && sameAmount(row.monto, candidate.monto))
                : [];
            if (choices.length === 1) existing = choices[0];
            else if (byAmount.length === 1) existing = byAmount[0];
            else {
                conflictingFields.add('demandados.resolucion_ambigua');
                rows.push({ ...candidate });
                continue;
            }
        }
        if (!existing) {
            rows.push({ ...candidate });
            continue;
        }
        for (const key of Object.keys(candidate)) {
            const same = key === 'monto' ? sameAmount
                : key === 'razon_social' ? sameCorporateName : sameFieldValue;
            if (!existing[key]) existing[key] = candidate[key];
            else if (candidate[key] && !same(existing[key], candidate[key])) {
                conflictingFields.add(`demandados.${key}`);
            }
        }
    }
    return { rows, conflictingFields };
}

/** Divide el texto sin descartar caracteres y prioriza límites de página o línea. */
function splitAdjuntoText(ocrText) {
    const chunks = [];
    let start = 0;
    const chunkChars = config.adjuntoChunkChars;

    while (start < ocrText.length) {
        let end = Math.min(start + chunkChars, ocrText.length);
        if (end < ocrText.length) {
            const pageEnd = ocrText.lastIndexOf('\n\n', end);
            const lineEnd = ocrText.lastIndexOf('\n', end);
            if (pageEnd >= start + chunkChars / 2) {
                end = pageEnd + 2;
            } else if (lineEnd > start) {
                end = lineEnd + 1;
            } else {
                // Una linea excepcionalmente larga se envia entera; nunca se
                // descarta ni se corta una fila en medio.
                const nextLineEnd = ocrText.indexOf('\n', end);
                end = nextLineEnd === -1 ? ocrText.length : nextLineEnd + 1;
            }
        }
        chunks.push(ocrText.slice(start, end));
        start = end;
    }

    if (chunks.length > 1 && chunks.at(-1).trim().length < 50) {
        chunks[chunks.length - 2] += chunks.pop();
    }

    return chunks;
}

async function extractAdjuntoChunk(chunk, index, total, mode, primaryText) {
    logger.info(`[ADJUNTO-EXTRACT] Extrayendo fragmento ${index + 1}/${total} (${chunk.length} chars)...`);

    const primaryInstruction = 'ALCANCE DE ESTA LLAMADA: el texto enviado es la pagina principal que identifica el documento con codigo R. Extrae de ella los campos del esquema. No inventes campos que solo podrian constar en otras paginas.';
    const userContent = mode === 'primary'
        ? `${renderPrompt(ADJUNTO_USER_PROMPT, { text: chunk })}\n\n${primaryInstruction}`
        : `Pagina principal de referencia (no extraer datos de aqui):\n<<<PRINCIPAL>>>\n${primaryText}\n<<<FIN PRINCIPAL>>>\n\nFragmento ${index + 1} de ${total}; extrae datos del mismo proceso solo de este fragmento:\n<<<FRAGMENTO>>>\n${chunk}\n<<<FIN FRAGMENTO>>>`;

    let maxTokens = ADJUNTO_MAX_OUTPUT_TOKENS;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        const model = modelForAttempt(attempt);

        try {
            const response = await openai.chat.completions.create({
                model,
                reasoning_effort: config.textReasoningEffort,
                max_completion_tokens: maxTokens,
                response_format: mode === 'primary' ? ADJUNTO_RESPONSE_FORMAT : ADJUNTO_CONTINUATION_RESPONSE_FORMAT,
                messages: [
                    {
                        role: 'system',
                        content: mode === 'primary'
                            ? `${ADJUNTO_PROMPT}\n\n${primaryInstruction}`
                            : ADJUNTO_CONTINUATION_PROMPT
                    },
                    {
                        role: 'user',
                        content: userContent
                    }
                ]
            });

            const choice = response.choices?.[0];
            if (choice?.finish_reason === 'length') {
                throw new TruncatedOutputError(`Extraccion de adjunto truncada: limite de ${maxTokens} tokens de salida`);
            }
            if (!choice || !choice.message || !choice.message.content) {
                throw new Error('Respuesta del modelo vacía o sin contenido');
            }

            const raw = choice.message.content.trim();
            const parsed = safeJsonParse(raw);

            if (!parsed) {
                throw new Error('JSON invalido devuelto por el modelo');
            }

            const normalized = normalizeAdjuntoResult(parsed);

            logger.success(`[ADJUNTO-EXTRACT] Campos del adjunto extraidos correctamente con ${model}`);
            return normalized;

        } catch (err) {
            // En diagnostico sin API este fragmento queda pendiente; los demas
            // adjuntos del TIFF se siguen reconstruyendo desde la cache.
            if (err?.code === 'offline_cache_miss') return { ...ADJUNTO_EMPTY, _error: err.message };
            throwIfInsufficientQuota(err, `[ADJUNTO-EXTRACT] OpenAI adjunto con ${model}`);

            // Repetir con el mismo tope volveria a truncar: se reintenta una
            // sola vez, con el doble de tokens.
            if (err instanceof TruncatedOutputError && maxTokens === ADJUNTO_MAX_OUTPUT_TOKENS && attempt < config.maxRetries) {
                maxTokens *= 2;
                logger.warn(`[ADJUNTO-EXTRACT] Reintento ${attempt}/${config.maxRetries} con ${model} - salida truncada, ahora con ${maxTokens} tokens`);
                continue;
            }

            const isRateLimit = err.status === 429;

            if (attempt < config.maxRetries && isRetryableOpenAIError(err)) {
                const waitTime = isRateLimit
                    ? config.retryDelayMs * attempt * 2
                    : config.retryDelayMs;

                logger.warn(
                    `[ADJUNTO-EXTRACT] Reintento ${attempt}/${config.maxRetries} con ${model} - ${err.message}`
                );
                await sleep(waitTime);
            } else {
                logger.error(
                    `[ADJUNTO-EXTRACT] Fallo en intento ${attempt}/${config.maxRetries} con ${model}: ${err.message}`
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

/** La pagina que contiene el codigo R define los campos del documento principal. */
export async function extractAdjuntoFields(ocrText, { primaryText, continuationTexts = [] } = {}) {
    if (!ocrText || ocrText.trim().length < 50) {
        logger.warn('[ADJUNTO-EXTRACT] Texto demasiado corto para extraer campos');
        return { ...ADJUNTO_EMPTY, _error: 'Texto del adjunto demasiado corto para extraer campos' };
    }

    let chunks;
    if (primaryText !== undefined) {
        if (!primaryText || !ocrText.startsWith(primaryText)) {
            return { ...ADJUNTO_EMPTY, _error: 'El texto del adjunto no comienza con la pagina principal' };
        }
        const continuationChunks = splitAdjuntoText(ocrText.slice(primaryText.length));
        chunks = [primaryText, ...continuationChunks];
        if (chunks.join('') !== ocrText) {
            return { ...ADJUNTO_EMPTY, _error: 'La division del adjunto no conservo todo el texto' };
        }
    } else {
        chunks = splitAdjuntoText(ocrText);
        if (chunks.join('') !== ocrText) {
            return { ...ADJUNTO_EMPTY, _error: 'La division del adjunto no conservo todo el texto' };
        }
    }

    const merged = { ...ADJUNTO_EMPTY, demandados: [] };
    const conflictingFields = new Set();
    const conflictingDetails = [];
    const differentValues = [];
    let processedChunks = 0;

    for (let index = 0; index < chunks.length; index++) {
        if (!chunks[index].trim()) continue;
        const result = await extractAdjuntoChunk(chunks[index], index, chunks.length, index === 0 ? 'primary' : 'continuation', chunks[0]);
        processedChunks = index + 1;
        if (result._error) {
            // El adjunto sigue rechazado, pero no se pierden los campos ya
            // extraidos de fragmentos anteriores al informar el problema.
            merged._error = `Fragmento ${index + 1}/${chunks.length}: ${result._error}`;
            merged._fragmentos_extraccion = index + 1;
            if (index + 1 < chunks.length) merged._fragmentos_pendientes = chunks.length - index - 1;
            return merged;
        }

        merged.demandados.push(...result.demandados);
        if (index === 0) {
            for (const key of Object.keys(ADJUNTO_EMPTY)) {
                if (key !== 'demandados') merged[key] = result[key];
            }
            applyTextFallbacks(merged, chunks[0]);
        } else {
            for (const key of ['juez', 'juzgado']) {
                if (!result[key]) continue;
                if (!merged[key]) merged[key] = result[key];
                else if (!sameFieldValue(merged[key], result[key])) {
                    if (sameAuthorityValue(key, merged[key], result[key])) {
                        if (key === 'juzgado' && !courtNumber(merged[key]) && courtNumber(result[key])) {
                            differentValues.push(`${key} "${merged[key]}" incompleto; se usa "${result[key]}" del fragmento ${index + 1}`);
                            merged[key] = result[key];
                        } else {
                            differentValues.push(`${key} "${result[key]}" en fragmento ${index + 1}; se conserva "${merged[key]}"`);
                        }
                    } else {
                        conflictingFields.add(key);
                        conflictingDetails.push(`${key}: "${merged[key]}" frente a "${result[key]}" (fragmento ${index + 1})`);
                    }
                }
            }
            for (const [valueKey, detailKey] of [
                ['tipo_documento_respaldo', 'nro_documento_respaldo'],
                ['monto_retenido', 'moneda']
            ]) {
                // El numero o la moneda aislados no pueden vincularse con el
                // tipo o el monto de otra pagina.
                if (!result[valueKey]) continue;
                const same = valueKey === 'monto_retenido' ? sameAmount : sameFieldValue;
                if (!merged[valueKey]) merged[valueKey] = result[valueKey];
                else if (!same(merged[valueKey], result[valueKey])) {
                    conflictingFields.add(valueKey);
                    continue;
                }
                if (result[detailKey]) {
                    if (!merged[detailKey]) merged[detailKey] = result[detailKey];
                    else if (!(detailKey === 'nro_documento_respaldo'
                        ? sameProcessNumber(merged[detailKey], result[detailKey])
                        : sameFieldValue(merged[detailKey], result[detailKey]))) {
                        conflictingFields.add(detailKey);
                    }
                }
            }
        }
        // Una contradiccion real ya impide publicar este adjunto. Consultar
        // los fragmentos siguientes solo consumiria tokens sin cambiar eso.
        if (conflictingFields.size > 0) break;
    }

    applyContinuationMetadataFallback(merged, continuationTexts);

    // El bloque de firma suele estar en una continuacion: el regex sobre la
    // pagina principal solo completa el juez si ningun fragmento lo leyo.
    const primaryJudge = extractJuezFallback(chunks[0]);
    if (!merged.juez) merged.juez = primaryJudge;
    else if (primaryJudge && !sameFieldValue(primaryJudge, merged.juez)) {
        if (sameAuthorityValue('juez', primaryJudge, merged.juez)) {
            differentValues.push(`juez "${primaryJudge}" segun la firma de la pagina principal; se conserva "${merged.juez}"`);
        } else {
            conflictingFields.add('juez');
            conflictingDetails.push(`juez: "${merged.juez}" frente a "${primaryJudge}" (firma de pagina principal)`);
        }
    }

    const mergedDemandados = mergeDemandados(merged.demandados);
    merged.demandados = mergedDemandados.rows;
    for (const key of mergedDemandados.conflictingFields) conflictingFields.add(key);
    if (conflictingFields.size > 0) {
        merged._revision = `Campos del mismo proceso contradictorios entre fragmentos: ${[...conflictingFields].join(', ')}`;
        if (conflictingDetails.length > 0) merged._conflictos = conflictingDetails;
    }
    if (differentValues.length > 0) merged._advertencia_valores_distintos = differentValues;
    if (chunks.length > 1) merged._fragmentos_extraccion = processedChunks;
    if (processedChunks < chunks.length) merged._fragmentos_pendientes = chunks.length - processedChunks;
    return merged;
}
