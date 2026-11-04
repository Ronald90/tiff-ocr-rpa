import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from './config.js';
import { processFile } from './ocr-engine.js';
import { formatDiagnosticAdjunto } from './diagnostic-summary.js';

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
        for (const adjunto of data.ubicacion_adjuntos || []) {
            for (const line of formatDiagnosticAdjunto(adjunto)) console.log(line);
        }
        for (const reason of data.motivos_incompleto || []) {
            if (!reason.startsWith('Diagnostico de cache:')) console.log(`PENDIENTE: ${reason}`);
        }
        if (data.ubicacion_adjuntos?.length && option !== '--full') {
            console.log('Para ver los valores recuperados, ejecuta este comando con --full.');
        }
        if (option === '--full') console.log(JSON.stringify(data, null, 2));
    } catch (error) {
        // Paginas y adjuntos sin cache quedan pendientes dentro del resultado.
        // Solo la caratula corta el diagnostico: sin ella no hay codigos R.
        const reason = error.code === 'offline_cache_miss'
            ? `la caratula no esta en la cache local (${error.message})`
            : error.message;
        console.error(`Diagnostico incompleto: ${reason}`);
        process.exitCode = 1;
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
