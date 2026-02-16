import OpenAI from 'openai';
import config from './config.js';
import proxyAgent from './proxy.js';

// Instancia compartida de OpenAI — reutilizada por ocr-engine.js y extractor.js
// fetchOptions.dispatcher inyecta el ProxyAgent de undici para redes corporativas
const options = { apiKey: config.apiKey };

if (proxyAgent) {
    options.fetchOptions = { dispatcher: proxyAgent };
}

const openai = new OpenAI(options);

export default openai;
