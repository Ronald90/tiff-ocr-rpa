import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';




const MAX_EXTRACT_CHARS = 8000;




const EMPTY_RESULT = {
    tipo_documento: '',
    documento: '',
    denominacion: '',
    ciudad: '',
    departamento: '',
    fecha: '',
    destinatario: '',
    referencia: '',
    numero_tramite: '',
    para_conocimiento: [],
    documentos_adjuntos: [],
    modificaciones: []
};




// Cargar prompts desde archivos externos
const EXTRACTION_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_caratula.txt'), 'utf-8');
const EXTRACTION_USER_PROMPT = fs.readFileSync(path.resolve('./prompts/extract_caratula_user.txt'), 'utf-8');




/**
 * Reemplaza marcadores {{variable}} en un template de prompt.
 */
function renderPrompt(template, vars = {}) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }
    return result;
}








/**
 * Garantiza que el resultado tenga todos los campos esperados
 */
function normalizeResult(data) {
    if (!data) return EMPTY_RESULT;
    
    // Asegurarse de que campos de listas sean arrays
    const listFields = ['para_conocimiento', 'documentos_adjuntos', 'modificaciones'];
    listFields.forEach(field => {
        if (!data[field]) data[field] = [];
        if (typeof data[field] === 'string') data[field] = [data[field]];
    });

    return { ...EMPTY_RESULT, ...data };
}

