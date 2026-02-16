import OpenAI from 'openai';
import config from './config.js';
import proxyAgent from './proxy.js';

// Instancia compartida de OpenAI — reutilizada por ocr-engine.js y extractor.js
// httpAgent inyecta el ProxyAgent de undici para redes corporativas con proxy
const openai = new OpenAI({
    apiKey: config.apiKey,
    httpAgent: proxyAgent,
});

export default openai;
