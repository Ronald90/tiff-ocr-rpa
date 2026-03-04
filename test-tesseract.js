import sharp from 'sharp';
import Tesseract from 'tesseract.js';

async function run() {
    const tiffPath = './input/03122025.235959_NUEVO_11122025.123353_CCA-11993_2025.tif';
    const buf = await sharp(tiffPath, { page: 0 }).resize({ width: 4096, withoutEnlargement: true }).png({ compressionLevel: 6 }).toBuffer();
    const { data: { text } } = await Tesseract.recognize(buf, 'spa');
    console.log("---- TEXTO ----");
    console.log(text);

    // Check original regex
    const pagMatch = text.match(/P[áa]g\.?\s*(\d+)\s*de\s*(\d+)/i);
    console.log("Original Regex Match:", pagMatch ? `Pag ${pagMatch[1]} de ${pagMatch[2]}` : null);

    // Check custom patterns
    const pagMatch2 = text.match(/P[aáe]g[^\d]*(\d+)[^\d]*de[^\d]*(\d+)/i);
    console.log("Loose Regex Match:", pagMatch2 ? `Pag ${pagMatch2[1]} de ${pagMatch2[2]}` : null);
}
run();
