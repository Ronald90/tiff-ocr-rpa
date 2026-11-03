import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import openai from '../openai-client.js';
import config from '../config.js';
import { processFile } from '../ocr-engine.js';

// Cada pagina de los fixtures mide 60 + numero de pagina px de ancho, asi el
// mock sabe que pagina recibe aunque el prompt no lo diga.
const fixture = path.resolve('tests/fixtures/ten-pages.tiff');
const longFixture = path.resolve('tests/fixtures/fourteen-pages.tiff');
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
 * (respuesta OCR por intento), `id` (identificacion libre), `verify` (segunda
 * lectura visual) y `targeted` (identificacion dirigida).
 */
function mockOpenAI(adjuntos, pages) {
    const calls = { ocr: [], id: [], targeted: [], extract: 0, extractTexts: [], maxActiveOcr: 0, maxActiveExtract: 0 };
    let activeOcr = 0;
    let activeExtract = 0;

    openai.chat.completions.create = async request => {
        const formatName = request.response_format?.json_schema?.name;
        if (formatName === 'caratula_extraction') {
            assert.equal(request.model, config.textModel);
            if (adjuntos === null) throw Object.assign(new Error('400 Invalid request'), { status: 400 });
            return completion(JSON.stringify({ documentos_adjuntos: adjuntos }));
        }
        if (formatName === 'adjunto_extraction') {
            assert.equal(request.model, config.textModel);
            calls.extract++;
            calls.extractTexts.push(request.messages[1].content);
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
            assert.ok([config.idModel, config.model].includes(request.model));
            calls.id.push(page);
            await delay(10);
            const codeInText = spec.text?.match(/R-\d{5,7}/)?.[0];
            return completion(request.model === config.model
                ? (spec.verify ?? spec.id ?? codeInText ?? 'NO_ENCONTRADO')
                : (spec.id ?? codeInText ?? 'NO_ENCONTRADO'));
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

async function run(tiffPath = fixture) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ocr-engine-'));
    try {
        return await processFile(tiffPath, outputDir);
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

describe('processFile', () => {
    it('marca error si la extraccion de caratula falla y no acepta una lista vacia', async () => {
        mockOpenAI(null, { 1: { text: COVER } });

        const data = (await run()).extractedData;

        assert.equal(data.tiene_errores, true);
        assert.equal(data.estado_procesamiento, 'error');
        assert.match(data.advertencias.join(' '), /Extraccion de caratula incompleta/);
    });

    it('acepta SIREFO de una pagina con adjunto sin R y conserva la referencia; otros faltantes siguen siendo errores', async () => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ocr-sirefo-'));
        const onePageTiff = path.join(fixtureDir, 'one-page.tiff');
        const externalAdjunto = 'el detalle de las instrucciones remitidas por la Aduana Nacional (AN)';
        const sirefoCover = 'Sistema de Transmision de Ordenes de Retencion, Suspension de Retencion y Remision de Fondos (SIREFO).';

        try {
            await sharp(fixture, { page: 0 }).tiff().toFile(onePageTiff);

            mockOpenAI([externalAdjunto], { 1: { text: sirefoCover } });
            const sirefo = (await run(onePageTiff)).extractedData;
            assert.equal(sirefo.es_sirefo, true);
            assert.equal(sirefo.tiene_errores, false);
            assert.deepEqual(sirefo.documentos_adjuntos, [externalAdjunto]);
            assert.equal(sirefo.codigos_no_encontrados, undefined);
            assert.match(sirefo.advertencias.join(' '), /no incluido/);

            mockOpenAI([externalAdjunto], { 1: { text: COVER } });
            const ordinary = (await run(onePageTiff)).extractedData;
            assert.equal(ordinary.es_sirefo, false);
            assert.equal(ordinary.tiene_errores, true);
            assert.deepEqual(ordinary.codigos_no_encontrados, ['SIN_CODIGO']);

            mockOpenAI(['R-12345'], { 1: { text: sirefoCover } });
            const missingCode = (await run(onePageTiff)).extractedData;
            assert.equal(missingCode.tiene_errores, true);
            assert.deepEqual(missingCode.codigos_no_encontrados, ['R-12345']);
        } finally {
            fs.rmSync(fixtureDir, { recursive: true, force: true });
        }
    });

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
        // La ubicación sale del texto; la segunda lectura confirma cada código en imagen.
        assert.equal(calls.id.filter(page => page === 2).length, 1);
        assert.equal(calls.id.filter(page => page === 4).length, 1);
        assert.ok(data.ubicacion_adjuntos.every(a => a.codigo_verificado));
        assert.deepEqual(calls.targeted, []);
        // La pagina 6 tiene otro codigo y cierra el ultimo adjunto.
        assert.equal(ocrPages.has(9) || ocrPages.has(10), false);
        assert.equal(calls.ocr.length, ocrPages.size);
        assert.equal(result.success, ocrPages.size);
        assert.equal(calls.maxActiveOcr, 2);
        assert.equal(calls.maxActiveExtract, 2);
    });

    it('agrega todas las continuaciones de un adjunto largo sin cortar en paginas en blanco', async () => {
        const pages = { 1: { text: COVER }, 2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` } };
        for (let page = 3; page <= 14; page++) {
            pages[page] = { text: page === 8 ? '' : `${CONTINUACION} Fila ${page}.` };
        }
        const calls = mockOpenAI(['R-12345'], pages);

        const result = await run(longFixture);
        const data = result.extractedData;
        const sent = calls.extractTexts.join('\n');

        assert.equal(data.tiene_errores, false);
        // 12 paginas despues del sello: 11 con texto y la 8 en blanco.
        assert.deepEqual(data.ubicacion_adjuntos.map(a => [a.pagina, a.paginas_continuacion]), [[2, 11]]);
        assert.ok([3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14].every(page => sent.includes(`Fila ${page}.`)));
        assert.equal(result.success, 14);
        assert.equal(data.paginas_omitidas, 1);
    });

    it('usa la imagen cuando el texto no muestra el codigo y rescata pendientes con identificacion dirigida', async () => {
        const calls = mockOpenAI(['R-12345', 'R-54321'], {
            1: { text: COVER },
            2: { text: OFICIO, id: 'R-12345' },
            3: { text: OFICIO, targeted: 'R-54321', verify: 'R-54321' }
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

    it('requiere revision cuando la segunda lectura visual no confirma todos los digitos', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}`, id: 'R-12346' }
        });

        const data = (await run()).extractedData;

        assert.equal(data.tiene_errores, true);
        assert.equal(data.estado_procesamiento, 'requiere_revision');
        assert.deepEqual(data.codigos_no_verificados, [
            { pagina: 2, esperado: 'R-12345', lectura_visual: 'R-12346' }
        ]);
        assert.equal(data.ubicacion_adjuntos[0].codigo_verificado, false);
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
