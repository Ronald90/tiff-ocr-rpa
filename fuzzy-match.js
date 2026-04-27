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
    return raw
        .toUpperCase()
        .replace(/^[RPKBH]\s*[-–—./]?\s*/i, '')
        .replace(/[I|L]/g, '1')
        .replace(/[OQ]/g, '0')
        .replace(/S/g, '5')
        .replace(/\D/g, '');
}

function collectLooseCodeCandidatesFromLines(lines) {
    const seen = new Set();
    const candidates = [];
    const regex = /(?:[RrPpKkBbHh]\s*[-–—./]?\s*)?(?:[0-9Iil|/\\]\s*){5,8}/g;

    for (const line of lines) {
        const matches = line.match(regex) || [];
        for (const match of matches) {
            const normalized = normalizeLooseCodeCandidate(match);
            if (normalized.length < 5 || normalized.length > 7) continue;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            candidates.push(normalized);
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

    const match = docText.match(/\bR\s*[-.]?\s*((?:\d\s*){5,7})\b/i);
    if (match) return `R-${match[1].replace(/\s+/g, '')}`;

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

    const regex = /R\s*[-.]?\s*((?:\d\s*){5,7})/gi;
    const codes = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        codes.push(`R-${match[1].replace(/\s+/g, '')}`);
    }

    return [...new Set(codes)];
}

/**
 * Detecta si la lista de documentos contiene códigos muy similares entre sí
 * (distancia Levenshtein ≤ 2). Cuando esto ocurre, el matching debe ser más estricto
 * para evitar asignar datos judiciales a la persona equivocada.
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

    // Detectar si hay códigos similares en la lista para endurecer el matching
    const hasSimilarCodes = detectSimilarCodesInList(documentList);
    const maxDigitDistance = Number.isInteger(options.maxDigitDistance)
        ? options.maxDigitDistance
        : (hasSimilarCodes ? 0 : MAX_CODE_DIGIT_DISTANCE);
    const maxLengthDelta = Number.isInteger(options.maxLengthDelta)
        ? options.maxLengthDelta
        : 0;

    // Pre-normalizar el código identificado: convertir prefijos manuscritos comunes a R-
    let normalizedIdentified = identifiedNumber.trim();
    // Reemplazar prefijos confusos de letras: "P-", "K-", "B-", "h-" -> "R-".
    // Si no aparece letra, se comparan solo digitos con aproximacion controlada.
    normalizedIdentified = normalizedIdentified.replace(/^[PpKkBbHh]\s*[-–—.]\s*/, 'R-');

    // Comparar tanto con el original como con el normalizado
    const variants = [
        normalize(normalizedIdentified),
        normalize(identifiedNumber),
        normalize(normalizedIdentified).replace(/^R/, ''),
        normalize(identifiedNumber).replace(/^R/, '')
    ];
    // Eliminar duplicados
    const uniqueVariants = [...new Set(variants)];

    let bestScore = 0;
    let bestDoc = null;
    let bestCode = null;
    let bestSameDigitLength = false;
    let bestDistance = Infinity;
    let ambiguousBest = false;

    for (const doc of documentList) {
        const code = extractDocCode(doc);
        if (!code) continue;

        const cleanCode = normalize(code);
        const codeDigits = cleanCode.replace(/\D/g, '');
        const codeVariants = [cleanCode, codeDigits];

        for (const cleanIdentified of uniqueVariants) {
            const identifiedDigits = cleanIdentified.replace(/\D/g, '');
            if (Math.abs(identifiedDigits.length - codeDigits.length) > maxLengthDelta) {
                continue;
            }

            const hasRPrefix = cleanIdentified.startsWith('R');
            const targetVariants = hasRPrefix
                ? codeVariants
                : [codeDigits];

            for (const cleanTarget of targetVariants) {
                // Comparación directa con Levenshtein
                const dist = levenshteinDistance(cleanIdentified, cleanTarget);
                const maxLen = Math.max(cleanIdentified.length, cleanTarget.length);
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

    const lines = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const focusIndexes = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /ASFI|RECEPCION|RECEPCIÓN|TRAMITE|TRÁMITE|AUTORIDAD DE SUPERVISION/i.test(line))
        .map(({ index }) => index);

    const focusedLines = [];
    for (const index of focusIndexes) {
        for (let offset = -1; offset <= 3; offset++) {
            const candidateLine = lines[index + offset];
            if (candidateLine) focusedLines.push(candidateLine);
        }
    }

    const focusedCandidates = collectLooseCodeCandidatesFromLines(focusedLines);
    if (focusedCandidates.length > 0) {
        return focusedCandidates;
    }

    return collectLooseCodeCandidatesFromLines(lines);
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
