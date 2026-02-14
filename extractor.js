import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';

const EXTRACTION_PROMPT = `Eres un sistema de extracción de datos de documentos oficiales de Bolivia (ASFI, reguladores financieros, entidades gubernamentales, etc.).

A partir del texto OCR de un documento, extrae los siguientes campos en formato JSON:

{
  "tipo_documento": "Tipo de documento tal como aparece en el texto.",
  "numero_documento": "Número o código identificador del documento tal como aparece en el texto.",
  "ciudad": "Ciudad donde se emitió el documento, tal como aparece en el texto.",
  "departamento": "Departamento de Bolivia al que pertenece la ciudad. Usa tu conocimiento de la geografía boliviana para identificarlo.",
  "fecha": "Fecha del documento normalizada a formato ISO YYYY-MM-DD. Puede venir en cualquier formato de texto.",
  "destinatario": "Nombre o institución a quien va dirigido. Si solo dice 'Señores' sin especificar, déjalo como string vacío.",
  "referencia": "Asunto o referencia del documento. Busca después de 'REF:' o 'REFERENCIA:'.",
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

/**
 * Extrae campos estructurados del texto OCR usando GPT-4o.
 * @param {string} ocrText — Texto completo del OCR (todas las páginas concatenadas)
 * @returns {object} — Campos extraídos
 */
export async function extractFields(ocrText) {
    try {
        logger.info('🔍 Extrayendo campos del documento...');

        const response = await openai.chat.completions.create({
            model: config.model,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: EXTRACTION_PROMPT },
                { role: 'user', content: `Extrae los campos del siguiente texto de documento:\n\n${ocrText}` }
            ],
            max_tokens: 1024,
            temperature: 0.0
        });

        const raw = response.choices[0].message.content.trim();
        const data = JSON.parse(raw);

        logger.success('🔍 Campos extraídos correctamente');
        return data;

    } catch (err) {
        logger.error(`🔍 Error extrayendo campos: ${err.message}`);

        return {
            tipo_documento: '',
            numero_documento: '',
            ciudad: '',
            departamento: '',
            fecha: '',
            destinatario: '',
            referencia: '',
            para_conocimiento: [],
            documentos_adjuntos: [],
            _error: err.message
        };
    }
}
