import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';

const SHA256 = /^[a-f0-9]{64}$/;
const R_CODE = /^R-\d{5,7}$/;

/** Identifica el TIFF completo; nombre y fecha de archivo no bastan. */
export async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

/** Devuelve solo confirmaciones válidas para este contenido exacto. */
export function loadManualCodeConfirmations(fileHash, confirmationsFile) {
    const confirmations = new Map();
    if (!SHA256.test(fileHash) || !confirmationsFile || !fs.existsSync(confirmationsFile)) return confirmations;

    for (const line of fs.readFileSync(confirmationsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.hash_archivo_sha256 !== fileHash ||
            !Number.isInteger(entry.pagina) || entry.pagina < 1 ||
            !R_CODE.test(entry.codigo) || !entry.fecha_iso) continue;

        const previous = confirmations.get(entry.pagina);
        // Dos decisiones incompatibles para la misma pagina requieren nueva
        // revision humana; ninguna de ellas se acepta automaticamente.
        if (previous === null || (previous && previous.codigo !== entry.codigo)) {
            confirmations.set(entry.pagina, null);
        } else {
            confirmations.set(entry.pagina, entry);
        }
    }
    return confirmations;
}

/** Registra una decisión humana explícita sin consultar la API. */
export async function recordManualCodeConfirmation(tiffPath, pageNumber, code, confirmationsFile) {
    if (!confirmationsFile) throw new Error('Configura MANUAL_CODE_CONFIRMATIONS_FILE en .env antes de confirmar');
    const page = Number(pageNumber);
    if (!Number.isInteger(page) || page < 1) throw new Error('La pagina debe ser un entero positivo');
    if (!R_CODE.test(code)) throw new Error('El codigo debe tener formato R- seguido de 5 a 7 digitos');
    const stat = fs.statSync(tiffPath);
    if (!stat.isFile()) throw new Error('El archivo indicado no es un TIFF regular');
    if (!/\.tiff?$/i.test(tiffPath)) throw new Error('El archivo debe ser .tif o .tiff');
    const metadata = await sharp(tiffPath).metadata();
    if (page > (metadata.pages || 1)) throw new Error(`La pagina ${page} no existe en el TIFF`);

    const fileHash = await sha256File(tiffPath);
    const existing = loadManualCodeConfirmations(fileHash, confirmationsFile).get(page);
    if (existing === null || (existing && existing.codigo !== code)) {
        throw new Error('Ya existe una confirmacion distinta para esta pagina; requiere revision del registro');
    }
    if (existing) return existing;

    const entry = {
        hash_archivo_sha256: fileHash,
        pagina: page,
        codigo: code,
        fecha_iso: new Date().toISOString()
    };
    fs.appendFileSync(confirmationsFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    return entry;
}
