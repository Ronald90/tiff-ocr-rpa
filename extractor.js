import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';

// Máximo de caracteres a enviar al extractor (≈ primeras 2-3 páginas)
const MAX_EXTRACT_CHARS = 8000;

const EXTRACTION_PROMPT = `Eres un sistema de extracción de datos de documentos oficiales de Bolivia (ASFI, reguladores financieros, entidades gubernamentales, etc.).

A partir del texto OCR de un documento, extrae los siguientes campos en formato JSON:

{
  "tipo_documento": "Tipo de documento tal como aparece en el texto.",
  "numero_documento": "Número o código identificador del documento tal como aparece en el texto.",
  "ciudad": "Ciudad donde se emitió el documento, tal como aparece en el texto.",
  "departamento": "Departamento de Bolivia al que pertenece la ciudad. Usa tu conocimiento de la geografía boliviana para identificarlo.",
  "fecha": "Fecha del documento normalizada a formato ISO YYYY-MM-DD. Puede venir en cualquier formato de texto.",
  "destinatario": "Nombre o institución a quien va dirigido. Si solo dice 'Señores' sin especificar, déjalo como string vacío.",
  "referencia": "Asunto o referencia del documento. Busca después de 'REF:' o 'REFERENCIA:'. Incluye todo el texto de la referencia.",
  "numero_tramite": "Número de trámite que aparece en la referencia, generalmente con formato 'T-XXXXXXXXXX' después de 'TRÁMITE Nº'. Si no existe, devuelve string vacío.",
  "para_conocimiento": "Array con las entidades listadas para conocimiento y cumplimiento. Si no existe esta sección, devuelve array vacío.",
  "documentos_adjuntos": "Array con los documentos adjuntos o detallados que se mencionan. Si no existen, devuelve array vacío."
}

REGLAS:
- Extrae los valores TAL COMO aparecen en el texto del documento, no inventes datos.
- Si un campo de texto no se encuentra, usa string vacío "".
- Si un campo de array no se encuentra, usa array vacío [].
- La fecha SIEMPRE debe normalizarse a formato YYYY-MM-DD sin importar cómo esté escrita.
- Para el departamento, identifícalo usando tu conocimiento completo de la geografía de Bolivia. Los 9 departamentos son: La Paz, Santa Cruz, Cochabamba, Chuquisaca, Oruro, Potosí, Tarija, Beni, Pando.
- Devuelve ÚNICAMENTE el JSON válido, sin explicaciones, comentarios ni markdown.`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extrae campos estructurados del texto OCR usando GPT-4o.
 * Solo envía las primeras páginas (≈8000 chars) para ahorrar tokens,
 * ya que los metadatos del documento siempre están al inicio.
 * @param {string} ocrText — Texto completo del OCR (todas las páginas concatenadas)
 * @returns {object} — Campos extraídos
 */
export async function extractFields(ocrText) {
    // Solo enviar las primeras páginas — los metadatos están al inicio
    const truncated = ocrText.length > MAX_EXTRACT_CHARS
        ? ocrText.substring(0, MAX_EXTRACT_CHARS) + '\n\n[... texto restante omitido ...]'
        : ocrText;

    const charsSent = truncated.length;
    logger.info(`🔍 Extrayendo campos del documento (${charsSent} chars de ${ocrText.length} total)...`);

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            const response = await openai.chat.completions.create({
                model: config.model,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: EXTRACTION_PROMPT },
                    { role: 'user', content: `Extrae los campos del siguiente texto de documento:\n\n${truncated}` }
                ],
                max_tokens: 1024,
                temperature: 0.0
            });

            const raw = response.choices[0].message.content.trim();
            const data = JSON.parse(raw);

            logger.success('🔍 Campos extraídos correctamente');
            return data;

        } catch (err) {
            const isRateLimit = err.status === 429;
            const detail = err.code || err.cause?.code || err.message;

            if (attempt < config.maxRetries) {
                const waitTime = isRateLimit
                    ? config.retryDelayMs * attempt * 2  // Espera más larga para rate limits
                    : config.retryDelayMs;
                logger.warn(`🔍 Reintento extractor ${attempt}/${config.maxRetries}: ${detail} (espera ${waitTime / 1000}s)`);
                await sleep(waitTime);
            } else {
                logger.error(`🔍 Error extrayendo campos después de ${config.maxRetries} intentos: ${err.message}`);
                return {
                    tipo_documento: '',
                    numero_documento: '',
                    ciudad: '',
                    departamento: '',
                    fecha: '',
                    destinatario: '',
                    referencia: '',
                    numero_tramite: '',
                    para_conocimiento: [],
                    documentos_adjuntos: [],
                    _error: err.message
                };
            }
        }
    }
}
