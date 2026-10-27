import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import openai from '../openai-client.js';
import { processFile } from '../ocr-engine.js';

const originalCreate = openai.chat.completions.create;
const fixture = path.resolve('tests/fixtures/three-pages.tiff');
const coverText = 'Caratula de prueba para tramites de la autoridad financiera. Documentos adjuntos R-12345 y R-54321.';
const adjuntoText = code => `ASFI RECEPCION ${code}. CITE 100/2025. Demandante Persona de Prueba. Juez Juan Perez.`;

function completion(content) {
    return { choices: [{ message: { content } }] };
}

afterEach(() => {
    openai.chat.completions.create = originalCreate;
});

async function runScenario(identifyPages) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ocr-concurrency-'));
    let visionCalls = 0;
    let idCalls = 0;
    let activeVision = 0;
    let maxActiveVision = 0;

    openai.chat.completions.create = async request => {
        const formatName = request.response_format?.json_schema?.name;
        if (formatName === 'caratula_extraction') {
            return completion(JSON.stringify({ documentos_adjuntos: ['R-12345', 'R-54321'] }));
        }
        if (formatName === 'adjunto_extraction') {
            return completion(JSON.stringify({ nro_cite: 'CITE 100/2025', demandante: 'Persona de Prueba', juez: 'Juan Perez' }));
        }
        if (request.max_completion_tokens === 4096) {
            const call = ++visionCalls;
            if (call === 1) return completion(coverText);

            activeVision++;
            maxActiveVision = Math.max(maxActiveVision, activeVision);
            await new Promise(resolve => setTimeout(resolve, 25));
            activeVision--;
            return completion(adjuntoText(call === 2 ? 'R-12345' : 'R-54321'));
        }
        if (request.max_completion_tokens === 300) {
            return completion(identifyPages ? (idCalls++ === 0 ? 'R-12345' : 'R-54321') : 'NO_ENCONTRADO');
        }
        throw new Error(`Solicitud inesperada: ${request.max_completion_tokens}`);
    };

    try {
        const result = await processFile(fixture, outputDir);
        assert.equal(result.numPages, 3);
        assert.equal(result.errors, 0);
        assert.equal(result.success, 3);
        assert.equal(result.extractedData.tiene_errores, false);
        assert.deepEqual(result.extractedData.ubicacion_adjuntos.map(a => a.pagina), [2, 3]);
        assert.equal(visionCalls, 3);
        assert.equal(maxActiveVision, 2);
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

describe('transcripcion concurrente de paginas', () => {
    it('transcribe en paralelo paginas identificadas y conserva el orden de adjuntos', async () => {
        await runScenario(true);
    });

    it('transcribe en paralelo paginas de auditoria y asigna los codigos en orden', async () => {
        await runScenario(false);
    });
});
