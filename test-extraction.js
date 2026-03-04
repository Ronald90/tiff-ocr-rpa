import fs from 'fs';
import { extractPageAsPng, ocrWithVision, extractCodesFromImage } from './ocr-engine.js';

async function test() {
    const tiffPath = '/home/rvd/Documents/project/input/03122025.235959_NUEVO_11122025.123353_CCA-11993_2025.tif';
    console.log("Extrayendo png...");
    const page1Png = await extractPageAsPng(tiffPath, 0);
    
    console.log("Ejecutando extractCodesFromImage (Método B)...");
    const vision = await extractCodesFromImage(page1Png);
    console.log("VISION B:", vision);

    console.log("\nEjecutando OCR page 1...");
    const page1Text = await ocrWithVision(page1Png, 1);
    
    const regexCodesRaw = [];
    const lineRegex = /(?:^|\n)\s*\d{1,3}[\.\)\-]?\s*(R-\d{5,7}\s+DE\s+\d{1,2}\s+DE\s+\w+\s+DE\s+\d{4})/gi;
    let lineMatch;
    while ((lineMatch = lineRegex.exec(page1Text)) !== null) {
        regexCodesRaw.push(lineMatch[1].trim());
    }
    console.log("REGEX A:", regexCodesRaw);
}
test().catch(console.error);
