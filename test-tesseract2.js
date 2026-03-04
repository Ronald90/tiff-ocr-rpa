import sharp from 'sharp';
import Tesseract from 'tesseract.js';

async function run() {
    console.log("Iniciando...");
    const tiffPath = './input/03122025.235959_NUEVO_11122025.123353_CCA-11993_2025.tif';
    console.log("Leyendo TIFF...");
    const buf = await sharp(tiffPath, { page: 0 }).resize({ width: 4096, withoutEnlargement: true }).png({ compressionLevel: 6 }).toBuffer();
    console.log("Iniciando Tesseract...");
    const { data: { text } } = await Tesseract.recognize(buf, 'spa', {
        logger: m => console.log(m)
    });
    console.log("---- TEXTO ----");
    console.log(text);
}
run().catch(console.error);
