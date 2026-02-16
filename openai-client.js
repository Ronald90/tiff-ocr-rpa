import OpenAI from 'openai';
import config from './config.js';
import proxyFetch from './proxy.js';

// Instancia compartida de OpenAI — reutilizada por ocr-engine.js y extractor.js
// Si hay proxy, se inyecta un fetch custom con undici ProxyAgent como dispatcher.
const options = { apiKey: config.apiKey };

if (proxyFetch) {
    options.fetch = proxyFetch;
}

const openai = new OpenAI(options);

export default openai;
