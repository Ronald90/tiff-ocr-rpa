import logger from './logger.js';

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

/**
 * Busca la mejor coincidencia aproximada de una subcadena (query) dentro de un texto más grande.
 * Elimina espacios y puntuación para facilitar la coincidencia de OCR.
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
    const match = docText.match(/([A-Z0-9]+-[A-Z0-9]+)/i);
    return match ? match[1] : docText.split(' ')[0];
}

/**
 * Dado un número identificado por el prompt barato (ej. "R-241594" o "R-24I594"),
 * busca cuál documento de la lista de adjuntos es el match más cercano.
 * @param {string} identifiedNumber — Número identificado en la página (puede tener errores OCR)
 * @param {string[]} documentList — Lista de documentos adjuntos completos del extractFields
 * @returns {{ matched: boolean, documento: string|null, code: string|null, score: number }}
 */
export function matchSingleNumber(identifiedNumber, documentList) {
    if (!identifiedNumber || !documentList || documentList.length === 0) {
        return { matched: false, documento: null, code: null, score: 0 };
    }

    const cleanIdentified = normalize(identifiedNumber);
    let bestScore = 0;
    let bestDoc = null;
    let bestCode = null;

    for (const doc of documentList) {
        const code = extractDocCode(doc);
        const cleanCode = normalize(code);

        // Comparación directa con Levenshtein
        const dist = levenshteinDistance(cleanIdentified, cleanCode);
        const maxLen = Math.max(cleanIdentified.length, cleanCode.length);
        const score = maxLen === 0 ? 0 : Math.max(0, 1 - (dist / maxLen));

        if (score > bestScore) {
            bestScore = score;
            bestDoc = doc;
            bestCode = code;
        }
    }

    return {
        matched: bestScore >= 0.7,
        documento: bestScore >= 0.7 ? bestDoc : null,
        code: bestScore >= 0.7 ? bestCode : null,
        score: parseFloat(bestScore.toFixed(4))
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
