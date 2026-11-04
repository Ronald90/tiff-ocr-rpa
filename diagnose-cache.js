import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from './config.js';
import { processFile } from './ocr-engine.js';

const [tiffPath, option] = process.argv.slice(2);
if (!tiffPath || (option && option !== '--full') || process.argv.length > 4) {
    console.error('Uso: npm run diagnose-cache -- <archivo.tif> [--full]');
    process.exitCode = 1;
} else if (!config.ocrCacheDir) {
    console.error('Configura OCR_CACHE_DIR en .env para diagnosticar sin usar la API.');
    process.exitCode = 1;
} else {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ocr-diagnose-'));
    try {
        console.log('Diagnostico local: se usaran solo respuestas de .ocr-cache; ninguna llamada nueva a la API.');
        const result = await processFile(tiffPath, tempDir, { diagnostic: true });
        const data = result.extractedData;
        console.log(`Diagnostico terminado: ${data.ubicacion_adjuntos?.length || 0} adjunto(s) con datos parciales.`);
        for (const reason of data.errores_bloqueantes || []) {
            if (!reason.startsWith('Diagnostico de cache:')) console.log(`MOTIVO: ${reason}`);
        }
        if (option === '--full') console.log(JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Diagnostico incompleto: ${error.message}`);
        process.exitCode = 1;
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
