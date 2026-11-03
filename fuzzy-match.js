/**
 * Calcula la distancia de Levenshtein entre dos cadenas de texto.
 */
function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // sustitución
                    matrix[i][j - 1] + 1,     // inserción
                    matrix[i - 1][j] + 1      // borrado
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

/**
 * Normaliza un string eliminando todo excepto letras y dígitos, y pasa a mayúsculas.
 */
function normalize(str) {
    return str.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

const MAX_CODE_DIGIT_DISTANCE = 1;
const MIN_CONFIDENCE_THRESHOLD = 0.80;
const CODE_PREFIXES = new Set(['R', 'P', 'K', 'B', 'H']);
const CODE_MIN_DIGITS = 5;
const CODE_MAX_DIGITS = 7;
const SPANISH_MONTHS = {
    ENE: '01',
    ENERO: '01',
    FEB: '02',
    FEBRERO: '02',
    MAR: '03',
    MARZO: '03',
    ABR: '04',
    ABRIL: '04',
    MAY: '05',
    MAYO: '05',
    JUN: '06',
    JUNIO: '06',
    JUL: '07',
    JULIO: '07',
    AGO: '08',
    AGOSTO: '08',
    SEP: '09',
    SEPT: '09',
    SEPTIEMBRE: '09',
    SET: '09',
    SETIEMBRE: '09',
    OCT: '10',
    OCTUBRE: '10',
    NOV: '11',
    NOVIEMBRE: '11',
    DIC: '12',
    DICIEMBRE: '12'
};

function mapDigitLikeChar(char = '') {
    if (/\d/.test(char)) return char;
    const upper = char.toUpperCase();
    if (upper === 'I' || upper === 'L' || char === '|') return '1';
    if (upper === 'O' || upper === 'Q') return '0';
    if (upper === 'S') return '5';
    return '';
}

function isCodeSeparator(char = '') {
    return /[\s\-–—./\\]/.test(char);
}

function isRiskyDigitLikeChar(char = '') {
    return /^[OQSoqs]$/.test(char);
}

function normalizeDigitLikeChars(raw = '') {
    let digits = '';
    for (const char of String(raw)) {
        const mapped = mapDigitLikeChar(char);
        if (mapped) digits += mapped;
    }
    return digits;
}

function nextNonSeparatorChar(text, startIndex) {
    for (let index = startIndex; index < text.length; index++) {
        if (!isCodeSeparator(text[index])) return text[index];
    }
    return '';
}

function scanDigitsAfterPrefix(text, startIndex) {
    let digits = '';
    let index = startIndex;
    const maxScanLength = 40;
    let previousWasSeparator = false;

    while (index < text.length && isCodeSeparator(text[index])) {
        index++;
    }

    const scanEnd = Math.min(text.length, index + maxScanLength);
    for (; index < scanEnd; index++) {
        const char = text[index];
        const mapped = mapDigitLikeChar(char);

        if (mapped) {
            const nextSignificant = nextNonSeparatorChar(text, index + 1);
            const riskyTrailingLetter = isRiskyDigitLikeChar(char) &&
                digits.length >= CODE_MIN_DIGITS &&
                previousWasSeparator &&
                !mapDigitLikeChar(nextSignificant);

            if (riskyTrailingLetter) break;

            digits += mapped;
            if (digits.length === CODE_MAX_DIGITS) {
                const nextSignificant = nextNonSeparatorChar(text, index + 1);
                return mapDigitLikeChar(nextSignificant) ? '' : digits;
            }
            previousWasSeparator = false;
            continue;
        }

        if (isCodeSeparator(char)) {
            if (digits.length >= CODE_MIN_DIGITS) break;
            previousWasSeparator = true;
            continue;
        }

        break;
    }

    return digits.length >= CODE_MIN_DIGITS && digits.length <= CODE_MAX_DIGITS
        ? digits
        : '';
}

function extractPrefixedCodeDigits(text = '') {
    const source = String(text);
    const codes = [];

    for (let index = 0; index < source.length; index++) {
        const char = source[index].toUpperCase();
        if (!CODE_PREFIXES.has(char)) continue;

        const previous = source[index - 1] || '';
        if (/[A-Z0-9]/i.test(previous)) continue;

        // "pisos 4" no es un código: sin esta comprobación P/I/S/O/S/4
        // se convierte en R-15054 por las equivalencias visuales.
        const next = source[index + 1] || '';
        if (!isCodeSeparator(next) && !/\d/.test(next)) continue;

        const digits = scanDigitsAfterPrefix(source, index + 1);
        if (digits) codes.push(digits);
    }

    return codes;
}

function normalizeMonthToken(token = '') {
    const upper = token
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z]/gi, '')
        .toUpperCase();

    return SPANISH_MONTHS[upper] || '';
}

function normalizeYearToken(token = '') {
    const digits = String(token).replace(/\D/g, '');
    if (digits.length === 4) return digits;
    if (digits.length === 2) return `20${digits}`;
    return '';
}

function buildDateKey(dayToken, monthToken, yearToken) {
    const day = String(dayToken).replace(/\D/g, '').padStart(2, '0');
    const month = normalizeMonthToken(monthToken);
    const year = normalizeYearToken(yearToken);

    if (!day || !month || !year) return '';
    return `${year}-${month}-${day}`;
}

function normalizeLooseCodeCandidate(raw = '') {
    const source = String(raw);
    if (/^[RPKBH][OQSoqsIil|]/i.test(source)) return '';
    return normalizeDigitLikeChars(source.replace(/^[RPKBH]\s*[-–—./]?\s*/i, ''));
}

function collectLooseCodeCandidatesFromLines(lines) {
    const seen = new Set();
    const candidates = [];
    const regex = /(?:[0-9Iil|OQoqSs]\s*[-–—./\\]?\s*){5,8}/g;

    function addCandidate(raw) {
        // Evita formar un código a partir de palabras como "isos 4".
        if ((raw.match(/\d/g) || []).length < 3) return;
        const normalized = normalizeLooseCodeCandidate(raw);
        if (normalized.length < CODE_MIN_DIGITS || normalized.length > CODE_MAX_DIGITS) return;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push(normalized);
    }

    for (const line of lines) {
        for (const digits of extractPrefixedCodeDigits(line)) {
            addCandidate(digits);
        }

        const matches = line.match(regex) || [];
        for (const match of matches) {
            addCandidate(match);
        }
    }

    return candidates;
}

/**
 * Busca la mejor coincidencia aproximada de una subcadena (query) dentro de un texto más grande.
 * Elimina espacios y puntuación para facilitar la coincidencia de transcripciones.
 */
export function findBestMatchInText(query, text) {
    if (!query || !text) return { found: false, score: 0 };

    const cleanQuery = normalize(query);
    const cleanText = normalize(text);

    if (cleanQuery.length === 0) return { found: false, score: 0 };

    if (cleanText.includes(cleanQuery)) {
        return { found: true, score: 1.0 };
    }

    const windowSize = cleanQuery.length;
    let bestDistance = Infinity;

    if (cleanText.length < windowSize) {
        bestDistance = levenshteinDistance(cleanQuery, cleanText);
    } else {
        for (let i = 0; i <= cleanText.length - windowSize; i++) {
            for (let w = -1; w <= 1; w++) {
                const wSize = windowSize + w;
                if (wSize <= 0 || i + wSize > cleanText.length) continue;

                const substring = cleanText.substring(i, i + wSize);
                const dist = levenshteinDistance(cleanQuery, substring);
                if (dist < bestDistance) {
                    bestDistance = dist;
                }
            }
        }
    }

    const maxLen = cleanQuery.length;
    const score = maxLen === 0 ? 0 : Math.max(0, 1 - (bestDistance / maxLen));

    return {
        found: score >= 0.7,
        score: parseFloat(score.toFixed(4)),
        distance: bestDistance
    };
}

/**
 * Extrae el código base de un documento adjunto.
 * Ejemplo: "R-241594 DE 20 DE OCTUBRE DE 2025" → "R-241594"
 */
export function extractDocCode(docText) {
    if (!docText) return null;

    const prefixedDigits = extractPrefixedCodeDigits(docText)[0];
    if (prefixedDigits) return `R-${prefixedDigits}`;

    const digitsOnly = docText.match(/\b(\d{5,7})\b/);
    if (digitsOnly) return `R-${digitsOnly[1]}`;

    // Fallback: buscar patrón genérico LETRA-NÚMERO
    const fallback = docText.match(/([A-Z0-9]+-[A-Z0-9]+)/i);
    return fallback ? fallback[1] : null;
}

/**
 * Extrae todos los códigos R-XXXXXX encontrados en un texto.
 * Útil para escanear una página completa y encontrar múltiples códigos.
 * @param {string} text — Texto donde buscar
 * @returns {string[]} — Array de códigos únicos encontrados (ej: ["R-263056", "R-264273"])
 */
export function extractRCodes(text) {
    if (!text) return [];

    const codes = [];

    for (const digits of extractPrefixedCodeDigits(text)) {
        codes.push(`R-${digits}`);
    }

    return [...new Set(codes)];
}

/**
 * Detecta si la lista de documentos contiene códigos muy similares entre sí
 * (distancia Levenshtein ≤ 2). Se informa como dato de auditoría; la
 * ambigüedad de cada candidato se resuelve en matchSingleNumber.
 * @param {string[]} documentList - Lista de documentos adjuntos
 * @returns {boolean}
 */
function detectSimilarCodesInList(documentList) {
    if (!documentList || documentList.length < 2) return false;

    const codes = documentList
        .map(doc => extractDocCode(doc))
        .filter(Boolean)
        .map(code => normalize(code));

    for (let i = 0; i < codes.length; i++) {
        for (let j = i + 1; j < codes.length; j++) {
            if (levenshteinDistance(codes[i], codes[j]) <= 2) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Dado un número identificado por el prompt barato (ej. "R-241594" o "R-24I594"),
 * busca cuál documento de la lista de adjuntos es el match más cercano.
 * @param {string} identifiedNumber — Número identificado en la página (puede tener errores de transcripción)
 * @param {string[]} documentList — Lista de documentos adjuntos completos del extractFields
 * @returns {{ matched: boolean, documento: string|null, code: string|null, score: number }}
 */
export function matchSingleNumber(identifiedNumber, documentList, options = {}) {
    if (!identifiedNumber || !documentList || documentList.length === 0) {
        return { matched: false, documento: null, code: null, score: 0 };
    }

    // Los códigos parecidos en otra parte de la lista no invalidan una
    // aproximación única de este candidato. Los empates se rechazan abajo.
    const hasSimilarCodes = detectSimilarCodesInList(documentList);
    const maxDigitDistance = Number.isInteger(options.maxDigitDistance)
        ? options.maxDigitDistance
        : MAX_CODE_DIGIT_DISTANCE;
    const maxLengthDelta = Number.isInteger(options.maxLengthDelta)
        ? options.maxLengthDelta
        : 0;

    const digitVariants = new Set();
    for (const code of extractRCodes(identifiedNumber)) {
        digitVariants.add(code.replace(/\D/g, ''));
    }

    const extractedIdentifiedCode = extractDocCode(identifiedNumber);
    if (extractedIdentifiedCode?.startsWith('R-')) {
        digitVariants.add(extractedIdentifiedCode.replace(/\D/g, ''));
    }

    const looseDigits = normalizeLooseCodeCandidate(identifiedNumber);
    if (looseDigits.length >= CODE_MIN_DIGITS && looseDigits.length <= CODE_MAX_DIGITS) {
        digitVariants.add(looseDigits);
    }

    const uniqueDigitVariants = [...digitVariants];
    if (uniqueDigitVariants.length === 0) {
        return { matched: false, documento: null, code: null, score: 0, similarCodesDetected: hasSimilarCodes };
    }

    let bestScore = 0;
    let bestDoc = null;
    let bestCode = null;
    let bestSameDigitLength = false;
    let bestDistance = Infinity;
    let ambiguousBest = false;

    for (const doc of documentList) {
        const code = extractDocCode(doc);
        if (!code) continue;

        const codeDigits = normalizeLooseCodeCandidate(code);

        for (const identifiedDigits of uniqueDigitVariants) {
            if (Math.abs(identifiedDigits.length - codeDigits.length) > maxLengthDelta) {
                continue;
            }

            const dist = levenshteinDistance(identifiedDigits, codeDigits);
            const maxLen = Math.max(identifiedDigits.length, codeDigits.length);
            const score = maxLen === 0 ? 0 : Math.max(0, 1 - (dist / maxLen));
            const validScore = dist <= maxDigitDistance;

            if (validScore && (score > bestScore || (score === bestScore && dist < bestDistance))) {
                bestScore = score;
                bestDistance = dist;
                bestDoc = doc;
                bestCode = code;
                bestSameDigitLength = true;
                ambiguousBest = false;
            } else if (validScore && score === bestScore && dist === bestDistance && code !== bestCode) {
                ambiguousBest = true;
            }
        }
    }

    const matched = bestSameDigitLength && !ambiguousBest && bestScore >= MIN_CONFIDENCE_THRESHOLD;

    return {
        matched,
        documento: matched ? bestDoc : null,
        code: matched ? bestCode : null,
        score: parseFloat(bestScore.toFixed(4)),
        similarCodesDetected: hasSimilarCodes
    };
}

/**
 * Busca una lista de IDs de documentos en un array de textos de páginas.
 */
export function findDocumentsInPages(documentTexts, pagesText) {
    const results = [];

    for (const docText of documentTexts) {
        const queryID = extractDocCode(docText);
        let bestPage = -1;
        let highestScore = 0;

        for (let i = 0; i < pagesText.length; i++) {
            const text = pagesText[i];
            const result = findBestMatchInText(queryID, text);

            if (result.found && result.score > highestScore) {
                highestScore = result.score;
                bestPage = i + 1;
            }
        }

        results.push({
            documento: docText,
            id_buscado: queryID,
            pagina: bestPage !== -1 ? bestPage : null,
            confianza: highestScore
        });
    }

    return results;
}

/**
 * Busca qué documento de la lista corresponde al texto de una página.
 * Extrae códigos R-XXXXXX del texto y los compara con fuzzy matching.
 * @param {string} pageText — Texto transcrito de la página
 * @param {string[]} documentList — Lista de documentos adjuntos pendientes
 * @returns {{ matched: boolean, documento: string|null, code: string|null, score: number }}
 */
export function matchPageWithDocuments(pageText, documentList) {
    const codesFound = extractRCodes(pageText);

    if (codesFound.length === 0) {
        return { matched: false, documento: null, code: null, score: 0 };
    }

    let bestResult = { matched: false, documento: null, code: null, score: 0 };

    for (const code of codesFound) {
        const result = matchSingleNumber(code, documentList);
        if (result.matched && result.score > bestResult.score) {
            bestResult = result;
        }
    }

    return bestResult;
}

/**
 * Extrae la fecha del documento adjunto listada en carátula.
 * Ejemplo: "R-258122 DE 07 DE NOVIEMBRE DE 2025" -> "2025-11-07"
 * @param {string} docText
 * @returns {string}
 */
export function extractDocDateKey(docText) {
    if (!docText) return '';

    const match = docText.match(/\bDE\s+(\d{1,2})\s+DE\s+([A-ZÁÉÍÓÚÑ.]+)\s+DE\s+(\d{2,4})\b/i);
    if (!match) return '';

    return buildDateKey(match[1], match[2], match[3]);
}

/**
 * Extrae fechas visibles del texto OCR de una página.
 * Soporta formatos como "07 NOV 2025", "7 NOV 25" o "15 de octubre de 2025".
 * @param {string} text
 * @returns {string[]}
 */
export function extractPageDateKeys(text) {
    if (!text) return [];

    const results = new Set();
    const regex = /\b(\d{1,2})\s*(?:DE\s+)?([A-ZÁÉÍÓÚÑ.]{3,15})\s*(?:DE\s+)?(\d{2,4})\b/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const key = buildDateKey(match[1], match[2], match[3]);
        if (key) results.add(key);
    }

    return [...results];
}

/**
 * Extrae candidatos de código flexibles desde el OCR de la página, tolerando
 * separadores o caracteres ambiguos como "/" leídos dentro del sello.
 * @param {string} text
 * @returns {string[]}
 */
export function extractLooseCodeCandidates(text) {
    if (!text) return [];

    const lines = splitTextLines(text);
    const focusedCandidates = collectLooseCodeCandidatesFromLines(collectStampLines(lines));
    if (focusedCandidates.length > 0) {
        return focusedCandidates;
    }

    return collectLooseCodeCandidatesFromLines(lines);
}

function splitTextLines(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

/**
 * Devuelve las líneas alrededor de sellos o recuadros ASFI/RECEPCION.
 * @param {string[]} lines
 * @returns {string[]}
 */
function collectStampLines(lines) {
    const focusedLines = [];

    lines.forEach((line, index) => {
        if (!/ASFI|RECEPCION|RECEPCIÓN|TRAMITE|TRÁMITE|AUTORIDAD DE SUPERVISION/i.test(line)) return;
        for (let offset = -1; offset <= 3; offset++) {
            const candidateLine = lines[index + offset];
            if (candidateLine) focusedLines.push(candidateLine);
        }
    });

    return focusedLines;
}

/**
 * Busca el código de la página solo con evidencia fuerte en el texto OCR:
 * códigos con prefijo R (o sus variantes manuscritas) con tolerancia de un
 * dígito, o secuencias sueltas junto a sellos ASFI/RECEPCION que coincidan
 * exactamente. Los números sueltos del cuerpo (CI, NIT, montos) no cuentan.
 * Si el texto apunta a más de un código de la lista, no decide.
 * @param {string} pageText
 * @param {string[]} documentList
 * @returns {{ matched: boolean, documento: string|null, code: string|null, score: number, candidate: string|null }}
 */
export function matchPageWithDocumentsByStamp(pageText, documentList) {
    const noMatch = { matched: false, documento: null, code: null, score: 0, candidate: null };
    if (!pageText || !documentList || documentList.length === 0) return noMatch;

    const prefixed = new Set(extractPrefixedCodeDigits(pageText));
    const stampLoose = collectLooseCodeCandidatesFromLines(collectStampLines(splitTextLines(pageText)));
    const matchedCodes = new Set();
    let best = noMatch;

    for (const digits of new Set([...prefixed, ...stampLoose])) {
        const result = matchSingleNumber(digits, documentList);
        if (!result.matched) continue;
        if (!prefixed.has(digits) && result.score < 1) continue;

        matchedCodes.add(result.code);
        if (result.score > best.score) {
            best = { ...result, candidate: `R-${digits}` };
        }
    }

    return matchedCodes.size === 1 ? best : noMatch;
}

/**
 * Busca un match usando contexto OCR de página: fechas visibles + candidatos
 * de código flexibles alrededor de sellos y recuadros.
 * @param {string} pageText
 * @param {string[]} documentList
 * @returns {{ matched: boolean, documento: string|null, code: string|null, score: number }}
 */
export function matchPageWithDocumentsByContext(pageText, documentList) {
    if (!pageText || !documentList || documentList.length === 0) {
        return { matched: false, documento: null, code: null, score: 0 };
    }

    const pageDates = new Set(extractPageDateKeys(pageText));
    const docsWithDate = pageDates.size > 0
        ? documentList.filter(doc => pageDates.has(extractDocDateKey(doc)))
        : [];

    const pools = docsWithDate.length > 0 ? [docsWithDate, documentList] : [documentList];
    const candidates = extractLooseCodeCandidates(pageText);

    let bestResult = { matched: false, documento: null, code: null, score: 0 };
    let bestAdjustedScore = 0;

    for (const pool of pools) {
        for (const candidate of candidates) {
            const result = matchSingleNumber(candidate, pool, { maxLengthDelta: 1, maxDigitDistance: 1 });
            if (!result.matched) continue;

            const docDate = extractDocDateKey(result.documento);
            const dateBonus = docDate && pageDates.has(docDate) ? 0.1 : 0;
            const adjustedScore = result.score + dateBonus;

            if (adjustedScore > bestAdjustedScore) {
                bestAdjustedScore = adjustedScore;
                bestResult = result;
            }
        }
    }

    return bestResult;
}
