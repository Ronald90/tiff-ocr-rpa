import config from './config.js';

// ── Utilidades compartidas ────────────────────────────────────────────

/**
 * Pausa la ejecución durante la cantidad de milisegundos indicada.
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reemplaza marcadores {{variable}} en un template de prompt.
 * @param {string} template - Template con marcadores {{key}}
 * @param {Record<string, string|number>} vars - Mapa clave-valor para reemplazar
 * @returns {string} - Template con los valores sustituidos
 */
export function renderPrompt(template, vars = {}) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }
    return result;
}

/**
 * Indica si existe un modelo fuerte de respaldo distinto al principal.
 * @returns {boolean}
 */
export function hasStrongFallback() {
    return Boolean(config.strongModel && config.strongModel !== config.model);
}

/**
 * Determina qué modelo usar para un intento dado.
 * En el último reintento usa el modelo fuerte si está disponible.
 * @param {number} attempt - Número de intento actual (1-indexed)
 * @param {string} [forcedModel] - Modelo forzado; si se especifica, se usa directamente
 * @returns {string} - Nombre del modelo a usar
 */
export function modelForAttempt(attempt, forcedModel) {
    if (forcedModel) return forcedModel;
    return hasStrongFallback() && attempt === config.maxRetries
        ? config.strongModel
        : config.model;
}

/**
 * Extrae JSON incluso si el modelo devuelve texto alrededor del objeto.
 * Intenta parseo directo primero, luego extracción con regex.
 * @param {string} text - Texto que puede contener un objeto JSON
 * @returns {object|null} - Objeto parseado o null si falla
 */
export function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;

        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

/**
 * Formatea una cantidad de segundos a formato legible (ej: "2m 15s" o "45s").
 * @param {number} seconds - Cantidad de segundos
 * @returns {string} - Tiempo formateado
 */
export function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Devuelve una etiqueta descriptiva de los modelos configurados.
 * @returns {string} - Ej: "gpt-5" o "gpt-5 | respaldo: gpt-5-turbo"
 */
export function modelLabel() {
    return hasStrongFallback()
        ? `${config.model} | respaldo: ${config.strongModel}`
        : config.model;
}
