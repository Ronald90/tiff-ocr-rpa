import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import openai from '../openai-client.js';
import config from '../config.js';
import { processFile } from '../ocr-engine.js';

// Cada pagina del fixture mide 60 + numero de pagina px de ancho, asi el mock
// sabe que pagina recibe aunque el prompt no lo diga.
const fixture = path.resolve('tests/fixtures/ten-pages.tiff');
const readPrompt = name => fs.readFileSync(path.resolve('prompts', name), 'utf-8');
const SYSTEM = {
    ocr: readPrompt('ocr_vision_system.txt'),
    id: readPrompt('id_doc_system.txt'),
    idExpected: readPrompt('id_doc_expected_system.txt')
};
const COVER = 'Caratula de prueba para tramites de la autoridad financiera con documentos adjuntos listados.';
const OFICIO = 'Oficio judicial de prueba. CITE 100/2025. Demandante Persona de Prueba. Juez Juan Perez.';
const CONTINUACION = 'Continuacion de la tabla de demandados del oficio anterior, sin sello de recepcion.';

const originalCreate = openai.chat.completions.create;
const originalConcurrency = config.concurrency;
const originalRetryDelayMs = config.retryDelayMs;

beforeEach(() => {
    config.concurrency = 2;
    config.retryDelayMs = 1;
});

afterEach(() => {
    openai.chat.completions.create = originalCreate;
    config.concurrency = originalConcurrency;
    config.retryDelayMs = originalRetryDelayMs;
});

function completion(content, finishReason = 'stop') {
    return { choices: [{ finish_reason: finishReason, message: { content } }] };
}

function pageOf(request) {
    const image = request.messages[1].content.find(part => part.type === 'image_url');
    const url = image.image_url.url;
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').readUInt32BE(16) - 60;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Instala un OpenAI falso. `pages[n]` define la pagina n: `text` (OCR), `ocr`
 * (respuesta OCR por intento), `id` (identificacion libre) y `targeted`
 * (identificacion dirigida).
 */
function mockOpenAI(adjuntos, pages) {
    const calls = { ocr: [], id: [], targeted: [], extract: 0, maxActiveOcr: 0, maxActiveExtract: 0 };
    let activeOcr = 0;
    let activeExtract = 0;

    openai.chat.completions.create = async request => {
        const formatName = request.response_format?.json_schema?.name;
        if (formatName === 'caratula_extraction') {
            assert.equal(request.model, config.textModel);
            return completion(JSON.stringify({ documentos_adjuntos: adjuntos }));
        }
        if (formatName === 'adjunto_extraction') {
            assert.equal(request.model, config.textModel);
            calls.extract++;
            activeExtract++;
            calls.maxActiveExtract = Math.max(calls.maxActiveExtract, activeExtract);
            await delay(10);
            activeExtract--;
            return completion(JSON.stringify({ nro_cite: 'CITE 100/2025', demandante: 'Persona de Prueba', juez: 'Juan Perez' }));
        }

        const page = pageOf(request);
        const spec = pages[page] || {};
        const system = request.messages[0].content;

        if (system === SYSTEM.ocr) {
            assert.equal(request.model, config.model);
            assert.equal(request.messages[1].content[1].image_url.detail, config.ocrImageDetail);
            calls.ocr.push({ page, maxTokens: request.max_completion_tokens });
            activeOcr++;
            calls.maxActiveOcr = Math.max(calls.maxActiveOcr, activeOcr);
            await delay(10);
            activeOcr--;
            if (spec.ocr) return spec.ocr(calls.ocr.filter(call => call.page === page).length);
            return completion(spec.text ?? '');
        }
        if (system === SYSTEM.id) {
            assert.equal(request.model, config.idModel);
            calls.id.push(page);
            await delay(10);
            return completion(spec.id ?? 'NO_ENCONTRADO');
        }
        if (system === SYSTEM.idExpected) {
            assert.equal(request.model, config.idModel);
            calls.targeted.push(page);
            await delay(10);
            return completion(spec.targeted ?? 'NO_ENCONTRADO');
        }
        throw new Error(`Solicitud inesperada para pagina ${page}`);
    };

    return calls;
}

async function run() {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ocr-engine-'));
    try {
        return await processFile(fixture, outputDir);
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

describe('processFile', () => {
    it('ubica por texto, agrupa continuaciones y deja de leer al cerrar el ultimo adjunto', async () => {
        const calls = mockOpenAI(['R-12345', 'R-54321'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: CONTINUACION },
            4: { text: `ASFI RECEPCION R-54321\n${OFICIO}` },
            5: { text: CONTINUACION },
            6: { text: `ASFI RECEPCION R-77777\n${OFICIO}`, id: 'R-77777' },
            7: { text: CONTINUACION },
            8: { text: CONTINUACION },
            9: { text: CONTINUACION },
            10: { text: CONTINUACION }
        });

        const result = await run();
        const data = result.extractedData;
        const ocrPages = new Set(calls.ocr.map(call => call.page));

        assert.equal(data.tiene_errores, false);
        assert.deepEqual(data.ubicacion_adjuntos.map(a => [a.pagina, a.id_buscado, a.paginas_continuacion]), [
            [2, 'R-12345', 1],
            [4, 'R-54321', 1]
        ]);
        // El sello leido en el texto basta: la imagen no se consulta para 2 y 4.
        assert.equal(calls.id.includes(2) || calls.id.includes(4), false);
        assert.deepEqual(calls.targeted, []);
        // La pagina 6 tiene otro codigo y cierra el ultimo adjunto.
        assert.equal(ocrPages.has(9) || ocrPages.has(10), false);
        assert.equal(calls.ocr.length, ocrPages.size);
        assert.equal(result.success, ocrPages.size);
        assert.equal(calls.maxActiveOcr, 2);
        assert.equal(calls.maxActiveExtract, 2);
    });

    it('usa la imagen cuando el texto no muestra el codigo y rescata pendientes con identificacion dirigida', async () => {
        const calls = mockOpenAI(['R-12345', 'R-54321'], {
            1: { text: COVER },
            2: { text: OFICIO, id: 'R-12345' },
            3: { text: OFICIO, targeted: 'R-54321' }
        });

        const result = await run();
        const data = result.extractedData;

        assert.equal(data.tiene_errores, false);
        assert.deepEqual(data.ubicacion_adjuntos.map(a => [a.pagina, a.id_buscado, a.id_encontrado]), [
            [2, 'R-12345', 'R-12345'],
            [3, 'R-54321', 'R-54321']
        ]);
        assert.deepEqual([...new Set(calls.id)].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
        // La dirigida solo corre al final, en paginas sin match, y para al ubicar el ultimo codigo.
        assert.equal(calls.targeted.includes(2), false);
        assert.ok(calls.targeted.length <= config.concurrency);
    });

    it('no reasigna en la reconciliacion un codigo que ya tiene otra pagina', async () => {
        mockOpenAI(['R-12345 DE 10 DE OCTUBRE DE 2025', 'R-54321 DE 20 DE OCTUBRE DE 2025'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n10 OCT 2025\n${OFICIO}` },
            // El OCR lee mal el sello (12346 con la fecha de R-12345), pero la
            // imagen identifica R-54321.
            3: { text: `ASFI\n10 OCT 2025\n12346\n${OFICIO}`, id: 'R-54321' }
        });

        const data = (await run()).extractedData;

        assert.deepEqual(data.ubicacion_adjuntos.map(a => a.id_buscado), ['R-12345', 'R-54321']);
        assert.equal(data.codigos_no_encontrados, undefined);
    });

    it('marca errores sin reintentar una solicitud invalida y reintenta un OCR truncado con mas tokens', async () => {
        const calls = mockOpenAI(['R-12345', 'R-54321'], {
            1: { text: COVER },
            2: {
                ocr: attempt => attempt === 1
                    ? completion('ASFI RECEPCION R-123', 'length')
                    : completion(`ASFI RECEPCION R-12345\n${OFICIO}`)
            },
            3: {
                ocr: () => {
                    throw Object.assign(new Error('400 Invalid image'), { status: 400 });
                }
            }
        });

        const result = await run();
        const data = result.extractedData;

        assert.deepEqual(calls.ocr.filter(call => call.page === 2).map(call => call.maxTokens), [
            config.ocrMaxOutputTokens,
            config.ocrMaxOutputTokens * 2
        ]);
        assert.equal(calls.ocr.filter(call => call.page === 3).length, 1);
        assert.equal(result.errors, 1);
        assert.equal(data.tiene_errores, true);
        assert.deepEqual(data.ubicacion_adjuntos.map(a => a.id_buscado), ['R-12345']);
        assert.deepEqual(data.codigos_no_encontrados, ['R-54321']);
    });
});
