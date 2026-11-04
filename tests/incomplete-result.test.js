import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preserveIncompleteOutputs } from '../incomplete-result.js';

const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('conserva TXT y JSON parciales del mismo intento fuera de output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-incomplete-test-'));
    dirs.push(root);
    const incompleteDir = path.join(root, 'incompletos');
    fs.mkdirSync(incompleteDir);
    const stagingDir = fs.mkdtempSync(path.join(incompleteDir, '.processing-'));
    const txtPath = path.join(stagingDir, 'archivo_vision.txt');
    const jsonPath = path.join(stagingDir, 'archivo_datos.json');
    fs.writeFileSync(txtPath, 'PAGINA 1\nPAGINA 189\nESTADO DE PROCESAMIENTO: INCOMPLETO');
    fs.writeFileSync(jsonPath, JSON.stringify({ estado_procesamiento: 'incompleto', ubicacion_adjuntos: [{ pagina: 1 }] }));

    const bundleDir = preserveIncompleteOutputs(stagingDir, incompleteDir, 'archivo.tif', txtPath, jsonPath);

    assert.equal(fs.existsSync(stagingDir), false);
    assert.ok(bundleDir.startsWith(incompleteDir + path.sep));
    assert.match(fs.readFileSync(path.join(bundleDir, 'archivo_vision.txt'), 'utf8'), /PAGINA 189/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(bundleDir, 'archivo_datos.json'), 'utf8')).estado_procesamiento, 'incompleto');
});
