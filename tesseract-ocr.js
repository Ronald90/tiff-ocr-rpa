import Tesseract from 'tesseract.js';
import logger from './logger.js';

/**
 * OCR de una imagen usando Tesseract.js (100% JavaScript, sin dependencias externas).
 * Ideal para texto impreso claro como listas numeradas de códigos.
 * @param {Buffer} pngBuffer — Buffer de la imagen PNG
 * @param {number} pageNum — Número de página (para logging)
 * @returns {string} — Texto extraído
 */
export async function ocrWithTesseract(pngBuffer, pageNum) {
    try {
        const { data: { text } } = await Tesseract.recognize(
            pngBuffer,
            'spa', // Español
            {
                logger: () => { } // Silenciar logs internos de Tesseract
            }
        );

        if (!text || text.trim().length === 0) {
            logger.warn(`[TESSERACT] Página ${pageNum}: No se extrajo texto`);
            return '';
        }

        return text.trim();
    } catch (err) {
        logger.error(`[TESSERACT] Error en página ${pageNum}: ${err.message}`);
        throw err;
    }
}
