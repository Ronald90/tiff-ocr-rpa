import OpenAI from 'openai';
import config from './config.js';

// Instancia compartida de OpenAI — reutilizada por ocr-engine.js y extractor.js
const openai = new OpenAI({ apiKey: config.apiKey });

export default openai;
