import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Conserva juntos los resultados parciales de un intento sin publicarlos en output/. */
export function preserveIncompleteOutputs(stagingDir, incompleteDir, filename, outputPath, jsonPath) {
    if (!fs.existsSync(outputPath) || !fs.existsSync(jsonPath)) {
        throw new Error('No se encontraron ambos resultados parciales para conservar');
    }

    const stem = path.basename(filename, path.extname(filename)).slice(0, 80);
    const bundleDir = path.join(incompleteDir, `${stem}_incompleto_${crypto.randomUUID()}`);
    fs.renameSync(stagingDir, bundleDir);
    return bundleDir;
}
