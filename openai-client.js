import OpenAI from 'openai';
import config from './config.js';
import proxyFetch from './proxy.js';
import { isInsufficientQuotaError } from './openai-errors.js';

// Instancia compartida de OpenAI — reutilizada por ocr-engine.js y extractor.js
// Si hay proxy, se inyecta un fetch custom con undici ProxyAgent como dispatcher.
const options = { apiKey: config.apiKey, maxRetries: 0 };

if (proxyFetch) {
    options.fetch = proxyFetch;
}

const openai = new OpenAI(options);

// Un solo límite para las llamadas de todos los archivos y etapas. El SDK no
// agrega reintentos ocultos: los reintentos del flujo usan MAX_RETRIES.
export function limitCompletions(create, maxInFlight, defaultRetryDelayMs) {
    const waiters = [];
    let active = 0;
    let cooldownUntil = 0;

    async function acquire() {
        if (active < maxInFlight && waiters.length === 0) {
            active++;
            return;
        }
        await new Promise(resolve => waiters.push(resolve));
    }

    function release() {
        const next = waiters.shift();
        if (next) next();
        else active--;
    }

    function retryAfterMs(err) {
        const header = err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after'];
        if (!header) return defaultRetryDelayMs;
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const date = Date.parse(header);
        return Number.isFinite(date) ? Math.max(0, date - Date.now()) : defaultRetryDelayMs;
    }

    return async (...args) => {
        for (;;) {
            const delay = cooldownUntil - Date.now();
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
            await acquire();
            if (Date.now() >= cooldownUntil) break;
            release();
        }

        try {
            return await create(...args);
        } catch (err) {
            if ((err?.status === 429 || err?.status === 503) && !isInsufficientQuotaError(err)) {
                cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterMs(err));
            }
            throw err;
        } finally {
            release();
        }
    };
}

const create = openai.chat.completions.create.bind(openai.chat.completions);
openai.chat.completions.create = limitCompletions(create, config.openaiMaxInFlight, config.retryDelayMs);

export default openai;
