import { ProxyAgent } from 'undici';
import logger from './logger.js';

// ── Proxy Corporativo ─────────────────────────────────────────────────
// Detecta HTTPS_PROXY / HTTP_PROXY del entorno (Windows/Linux)
// y exporta un ProxyAgent de undici para inyectar en el SDK de OpenAI.

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
let proxyAgent = undefined;

if (proxyUrl) {
    logger.info(`🌐 Proxy corporativo detectado: ${proxyUrl}`);
    proxyAgent = new ProxyAgent({
        uri: proxyUrl,
        connect: { timeout: 60_000 },
    });
} else {
    logger.debug('⚠️  No se detectó proxy (HTTPS_PROXY / HTTP_PROXY). Conexión directa.');
}

export default proxyAgent;
