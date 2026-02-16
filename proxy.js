import { ProxyAgent, fetch as undiciFetch } from 'undici';
import logger from './logger.js';

// ── Proxy Corporativo ─────────────────────────────────────────────────
// Detecta HTTPS_PROXY / HTTP_PROXY del entorno (Windows/Linux)
// y exporta una función fetch con proxy integrado para OpenAI SDK.

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

let proxyFetch = undefined;

if (proxyUrl) {
    logger.info(`🌐 Proxy corporativo detectado: ${proxyUrl}`);

    const agent = new ProxyAgent({
        uri: proxyUrl,
        connect: { timeout: 60_000 },
    });

    // Crear un fetch wrapper que inyecta el dispatcher de undici
    proxyFetch = (url, init = {}) => {
        return undiciFetch(url, { ...init, dispatcher: agent });
    };
} else {
    logger.debug('⚠️  No se detectó proxy (HTTPS_PROXY / HTTP_PROXY). Conexión directa.');
}

export default proxyFetch;
