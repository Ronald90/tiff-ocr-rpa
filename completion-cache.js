import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import logger from './logger.js';

const usageContext = new AsyncLocalStorage();
const cacheOnlyContext = new AsyncLocalStorage();

export class CacheOnlyMissError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CacheOnlyMissError';
        this.code = 'offline_cache_miss';
    }
}

/** Ejecuta un diagnostico sin permitir solicitudes nuevas al proveedor. */
export function withCacheOnly(work) {
    return cacheOnlyContext.run(true, work);
}

function recordRequest(model, usage) {
    const summary = usageContext.getStore();
    if (!summary) return;
    const item = summary.models.get(model) || {
        requests: 0, input: 0, output: 0, cachedInput: 0, withoutUsage: 0
    };
    item.requests++;
    if (usage) {
        item.input += usage.prompt_tokens || 0;
        item.output += usage.completion_tokens || 0;
        item.cachedInput += usage.prompt_tokens_details?.cached_tokens || 0;
    } else {
        item.withoutUsage++;
    }
    summary.models.set(model, item);
}

function recordReuse() {
    const summary = usageContext.getStore();
    if (summary) summary.reused++;
}

/** Registra consumo por TIFF incluso cuando termina en error. */
export async function withOpenAIUsage(label, work) {
    const summary = { models: new Map(), reused: 0 };
    return usageContext.run(summary, async () => {
        try {
            return await work();
        } finally {
            const models = [...summary.models].map(([model, item]) =>
                `${model}: ${item.requests} llamada(s), ${item.input} tokens entrada, ${item.output} salida` +
                (item.cachedInput ? ` (${item.cachedInput} entrada cacheada por OpenAI)` : '') +
                (item.withoutUsage ? ` (${item.withoutUsage} sin conteo informado)` : '')
            );
            if (models.length || summary.reused) {
                logger.info(`[API-USAGE] ${label}: ${summary.reused} llamada(s) reutilizada(s) sin nueva solicitud; ${models.join('; ') || 'sin llamadas nuevas'}`);
            }
        }
    });
}

function validResponse(response, request) {
    const choice = response?.choices?.[0];
    const content = choice?.message?.content;
    if (choice?.finish_reason !== 'stop' || typeof content !== 'string' || !content.trim()) return false;
    if (/^(?:lo siento|no puedo|i cannot|i'm sorry)/i.test(content.trim())) return false;
    // Una lectura negativa no debe quedar congelada: otro intento puede
    // descubrir un código que la primera lectura pasó por alto.
    if (content.trim().toUpperCase() === 'NO_ENCONTRADO') return false;
    if (request.response_format?.type === 'json_schema') {
        try {
            const parsed = JSON.parse(content);
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Guarda respuestas completas y válidas por huella de solicitud. La huella
 * incluye modelo, prompt, parámetros e imagen; cualquier cambio evita reutilizar
 * una respuesta anterior. Los archivos son binarios comprimidos, fuera de output/.
 */
export function cacheCompletions(create, cacheDir) {
    const inFlight = new Map();

    return async (request, options = {}) => {
        const { cacheMode, ...providerOptions } = options;
        const cacheOnly = cacheOnlyContext.getStore() === true;
        const run = async () => {
            if (cacheOnly) throw new CacheOnlyMissError('Diagnostico sin API: respuesta no disponible en la cache local');
            let response;
            try {
                response = await create(request, providerOptions);
                return response;
            } finally {
                recordRequest(request.model, response?.usage);
            }
        };

        if (!cacheDir || cacheMode === 'off') return run();

        const key = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const cachePath = path.join(cacheDir, `${key}.cache`);

        try {
            const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath)).toString('utf8'));
            if (validResponse(saved, request)) {
                recordReuse();
                return saved;
            }
            if (cacheOnly) throw new CacheOnlyMissError(`Diagnostico sin API: entrada de cache invalida (${key.slice(0, 12)})`);
            logger.warn(`[CACHE] Entrada inválida para ${key.slice(0, 12)}; se consultará la API.`);
        } catch (err) {
            if (cacheOnly) {
                if (err instanceof CacheOnlyMissError) throw err;
                throw new CacheOnlyMissError(`Diagnostico sin API: respuesta no disponible en cache (${key.slice(0, 12)}): ${err.message}`);
            }
            if (err.code !== 'ENOENT') logger.warn(`[CACHE] No se pudo leer ${key.slice(0, 12)}: ${err.message}`);
        }

        if (inFlight.has(key)) {
            recordReuse();
            return inFlight.get(key);
        }

        const promise = (async () => {
            const response = await run();
            if (validResponse(response, request)) {
                try {
                    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
                    const tmpPath = `${cachePath}.${crypto.randomUUID()}.tmp`;
                    try {
                        fs.writeFileSync(tmpPath, zlib.gzipSync(JSON.stringify({ choices: response.choices })), { mode: 0o600 });
                        fs.renameSync(tmpPath, cachePath);
                    } finally {
                        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                    }
                } catch (err) {
                    logger.warn(`[CACHE] No se pudo guardar ${key.slice(0, 12)}: ${err.message}`);
                }
            }
            return response;
        })();
        inFlight.set(key, promise);
        try {
            return await promise;
        } finally {
            inFlight.delete(key);
        }
    };
}
