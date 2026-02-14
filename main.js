import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import { processFile } from './ocr-engine.js';

// ── CLI: Procesar un archivo TIFF directamente ───────────────────────

if (process.argv.length < 3) {
    console.log('Uso:');
    console.log('  node main.js <archivo.tiff>          → Procesar un archivo');
    console.log('  node watcher.js                      → Modo RPA (monitor de carpeta)');
    process.exit(1);
}

const tiffPath = path.resolve(process.argv[2]);
const ext = path.extname(tiffPath).toLowerCase();

if (!['.tif', '.tiff'].includes(ext)) {
    console.error(`Error: Extensión no válida (${ext}). Usa .tif o .tiff`);
    process.exit(1);
}

if (!fs.existsSync(tiffPath)) {
    console.error(`Error: Archivo no encontrado: ${tiffPath}`);
    process.exit(1);
}

// Procesar (salida en el mismo directorio del archivo)
const outputDir = path.dirname(tiffPath);

try {
    const result = await processFile(tiffPath, outputDir);

    console.log('\n' + '='.repeat(60));
    console.log(`[OK] Completado en ${result.elapsed}`);
    console.log(`     Exitosas: ${result.success} | Errores: ${result.errors}`);
    console.log(`     TXT: ${result.outputPath}`);
    console.log(`     JSON: ${result.jsonPath}`);
    console.log('='.repeat(60));
    console.log('\n📋 Datos extraídos:');
    console.log(JSON.stringify(result.extractedData, null, 2));
} catch (err) {
    logger.error(`Error fatal: ${err.message}`);
    process.exit(1);
}
