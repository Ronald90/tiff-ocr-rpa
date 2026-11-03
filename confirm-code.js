import config from './config.js';
import { recordManualCodeConfirmation } from './manual-code-confirmations.js';

const [tiffPath, page, code] = process.argv.slice(2);
if (!tiffPath || !page || !code || process.argv.length !== 5) {
    console.error('Uso: npm run confirm-code -- <archivo.tif> <pagina> <R-XXXXX>');
    process.exitCode = 1;
} else {
    try {
        const entry = await recordManualCodeConfirmation(tiffPath, page, code, config.manualCodeConfirmationsFile);
        console.log(`Confirmacion manual registrada: pagina ${entry.pagina}, ${entry.codigo}, SHA-256 ${entry.hash_archivo_sha256}`);
    } catch (error) {
        console.error(`No se registro la confirmacion: ${error.message}`);
        process.exitCode = 1;
    }
}
