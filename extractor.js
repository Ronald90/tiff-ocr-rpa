import config from './config.js';
import logger from './logger.js';
import openai from './openai-client.js';

// Máximo de caracteres a enviar al extractor (≈ primeras 2-3 páginas)
const MAX_EXTRACT_CHARS = 8000;

const EXTRACTION_PROMPT = `Eres un sistema especializado de extracción de datos estructurados de documentos regulatorios del sistema financiero de Bolivia, emitidos por la Autoridad de Supervisión del Sistema Financiero (ASFI) y entidades relacionadas.

Tu tarea es analizar texto OCR extraído de documentos TIFF y devolver un JSON con los campos especificados. Los documentos pueden contener errores de OCR (caracteres mal reconocidos, espacios faltantes, saltos de línea incorrectos). Debes ser tolerante a estos errores.

═══════════════════════════════════════════
ESTRUCTURA TÍPICA DE LOS DOCUMENTOS ASFI
═══════════════════════════════════════════

Los documentos ASFI siguen esta estructura general en su encabezado:

  [Ciudad], [día] de [mes] de [año]
  [LÍNEA IDENTIFICADORA DEL DOCUMENTO]

  [TÍTULO DEL DOCUMENTO (puede estar en un recuadro o centrado)]

  Para conocimiento y debido cumplimiento de
  [DESTINATARIOS / ENTIDADES]

  REF: TRÁMITE Nº T-XXXXXXXXXX
  [DESCRIPCIÓN DE LA REFERENCIA]

  Se adjunta(n) el (los) documento(s) que se detalla(n) a continuación:
  1. R-XXXXXX DE DD DE MES DE YYYY
  2. R-XXXXXX DE DD DE MES DE YYYY
  ...

═══════════════════════════════════════════
CAMPOS A EXTRAER
═══════════════════════════════════════════

{
  "tipo_documento": "string — Clasificación del documento (ver reglas abajo)",
  "documento": "string — Línea identificadora completa tal cual aparece en el encabezado",
  "ciudad": "string — Ciudad de emisión",
  "departamento": "string — Departamento de Bolivia correspondiente a la ciudad",
  "fecha": "string — Fecha en formato ISO YYYY-MM-DD",
  "destinatario": "string — Institución o persona destinataria",
  "referencia": "string — Texto completo de la referencia (después de REF:)",
  "numero_tramite": "string — Código de trámite T-XXXXXXXXXX",
  "para_conocimiento": "array — Entidades listadas para conocimiento y cumplimiento",
  "documentos_adjuntos": "array — Lista de documentos adjuntos mencionados"
}

═══════════════════════════════════════════
REGLAS PARA tipo_documento Y documento
═══════════════════════════════════════════

La LÍNEA IDENTIFICADORA aparece en el encabezado, generalmente debajo de la fecha y ciudad. Esta línea es CLAVE para determinar tanto tipo_documento como documento.

REGLA PRINCIPAL:
→ Si la línea identificadora tiene texto ANTES de "ASFI" (separado por "/"), ese texto es el tipo_documento.
→ Si la línea identificadora comienza directamente con "ASFI/...", el tipo_documento se obtiene del TÍTULO visible en el cuerpo del documento.

EJEMPLOS CONCRETOS (entrada → salida esperada):

1. Línea: "CARTA CIRCULAR/ASFI/DAJ/CCA-11244/2025"
   → tipo_documento: "CARTA CIRCULAR"
   → documento: "CARTA CIRCULAR/ASFI/DAJ/CCA-11244/2025"

2. Línea: "CARTA CIRCULAR/ASFI/DCF/CCA-10552/2025"
   → tipo_documento: "CARTA CIRCULAR"
   → documento: "CARTA CIRCULAR/ASFI/DCF/CCA-10552/2025"

3. Línea: "CARTA CIRCULAR/ASFI/DAJ/CC-3710/2025"
   → tipo_documento: "CARTA CIRCULAR"
   → documento: "CARTA CIRCULAR/ASFI/DAJ/CC-3710/2025"

4. Línea: "ASFI/DAJ/CJ-8000/2025" + Título en el cuerpo: "NOTA DE REMISIÓN DE ORDEN JUDICIAL"
   → tipo_documento: "NOTA DE REMISIÓN DE ORDEN JUDICIAL"
   → documento: "ASFI/DAJ/CJ-8000/2025"

5. Línea: "ASFI/DAJ/CJ-8058/2025" + Título: "NOTA DE REMISIÓN DE ORDEN JUDICIAL"
   → tipo_documento: "NOTA DE REMISIÓN DE ORDEN JUDICIAL"
   → documento: "ASFI/DAJ/CJ-8058/2025"

6. Línea: "CIRCULAR/ASFI/XXX/C-1234/2025"
   → tipo_documento: "CIRCULAR"
   → documento: "CIRCULAR/ASFI/XXX/C-1234/2025"

7. Línea: "ASFI/XXX/R-5678/2025" + Título: "RESOLUCIÓN ADMINISTRATIVA"
   → tipo_documento: "RESOLUCIÓN ADMINISTRATIVA"
   → documento: "ASFI/XXX/R-5678/2025"

PROHIBICIONES para tipo_documento:
- NUNCA incluyas códigos como "ASFI/DAJ/CJ-8000/2025" en tipo_documento.
- NUNCA incluyas números, barras "/" ni códigos alfanuméricos.
- NUNCA repitas el contenido de documento en tipo_documento.
- tipo_documento debe ser SOLO texto descriptivo (ej: "CARTA CIRCULAR", "NOTA DE REMISIÓN DE ORDEN JUDICIAL", "CIRCULAR", "RESOLUCIÓN ADMINISTRATIVA", "INSTRUCTIVO").

═══════════════════════════════════════════
REGLAS PARA OTROS CAMPOS
═══════════════════════════════════════════

FECHA:
- Normaliza SIEMPRE a formato YYYY-MM-DD.
- "7 de noviembre de 2025" → "2025-11-07"
- "04/11/2025" → "2025-11-04"
- Si hay errores de OCR en el mes, usa el contexto para inferir (ej: "noviernbre" = noviembre).

CIUDAD Y DEPARTAMENTO:
- La ciudad aparece al inicio del documento (ej: "La Paz, 7 de noviembre de 2025").
- Identifica el departamento usando la geografía de Bolivia:
  La Paz → La Paz | Santa Cruz → Santa Cruz | Cochabamba → Cochabamba
  Sucre → Chuquisaca | Oruro → Oruro | Potosí → Potosí
  Tarija → Tarija | Trinidad → Beni | Cobija → Pando

DESTINATARIO:
- Si dice "Señores" o "Señores Presente" sin especificar institución, devuelve "".
- Si menciona una entidad específica (ej: "BANCO UNIÓN S.A. - GERENCIA GENERAL"), inclúyela completa.

REFERENCIA Y NÚMERO DE TRÁMITE:
- Busca después de "REF:", "REFERENCIA:", o "Ref:".
- El número de trámite tiene formato "T-XXXXXXXXXX" (después de "TRÁMITE Nº", "TRAMITE Nº", "TRÁMITE N°", con o sin tilde/acento).
- Si no existe referencia o trámite, devuelve "".

PARA_CONOCIMIENTO:
- Busca después de "Para conocimiento y debido cumplimiento de" o "Para conocimiento y cumplimiento de".
- Extrae cada entidad como un elemento del array.
- Ejemplo: ["Entidades de Intermediación Financiera", "Mercado de Valores"]
- Si no existe, devuelve [].

DOCUMENTOS_ADJUNTOS:
- Busca listas numeradas después de "Se adjunta(n) el (los) documento(s)..." o similar.
- Cada documento adjunto suele tener formato "R-XXXXXX DE DD DE MES DE YYYY".
- Extrae cada uno como string del array.
- Ejemplo: ["R-250439 DE 29 DE OCTUBRE DE 2025", "R-248533 DE 28 DE OCTUBRE DE 2025"]
- Si no existen, devuelve [].

═══════════════════════════════════════════
REGLAS GENERALES DE CALIDAD
═══════════════════════════════════════════

- Extrae valores TAL COMO aparecen en el texto. No inventes ni supongas datos.
- Si un campo de texto no se encuentra, usa string vacío "".
- Si un campo de array no se encuentra, usa array vacío [].
- Sé tolerante con errores de OCR: caracteres mal reconocidos, espacios incorrectos, tildes faltantes.
- NUNCA incluyas explicaciones, comentarios, ni formato markdown en la salida.
- Devuelve ÚNICAMENTE el JSON válido.`;

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
    logger.info(`[EXTRACT] Extrayendo campos del documento (${charsSent} chars de ${ocrText.length} total)...`);

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

            logger.success('[OK] Campos extraídos correctamente');
            return data;

        } catch (err) {
            const isRateLimit = err.status === 429;
            const detail = err.code || err.cause?.code || err.message;

            if (attempt < config.maxRetries) {
                const waitTime = isRateLimit
                    ? config.retryDelayMs * attempt * 2  // Espera más larga para rate limits
                    : config.retryDelayMs;
                logger.warn(`[RETRY] Reintento extractor ${attempt}/${config.maxRetries}: ${detail} (espera ${waitTime / 1000}s)`);
                await sleep(waitTime);
            } else {
                logger.error(`[ERROR] Error extrayendo campos después de ${config.maxRetries} intentos: ${err.message}`);
                return {
                    tipo_documento: '',
                    documento: '',
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
