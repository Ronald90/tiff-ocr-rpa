import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import openai from '../openai-client.js';
import logger from '../logger.js';
import config from '../config.js';
import { isVisuallyBlankPage, processFile } from '../ocr-engine.js';
import { recordManualCodeConfirmation } from '../manual-code-confirmations.js';
import { CacheOnlyMissError } from '../completion-cache.js';

// Cada pagina de los fixtures mide 60 + numero de pagina px de ancho, asi el
// mock sabe que pagina recibe aunque el prompt no lo diga.
const fixture = path.resolve('tests/fixtures/ten-pages.tiff');
const longFixture = path.resolve('tests/fixtures/fourteen-pages.tiff');
const inkFixture = path.resolve('tests/fixtures/three-pages-with-ink.tiff');
// La pagina 3 esta en blanco salvo motas aisladas, como un reverso escaneado.
const speckledFixture = path.resolve('tests/fixtures/three-pages-speckled.tiff');
const readPrompt = name => fs.readFileSync(path.resolve('prompts', name), 'utf-8');
const SYSTEM = {
    ocr: readPrompt('ocr_vision_system.txt'),
    id: readPrompt('id_doc_system.txt'),
    idExpected: readPrompt('id_doc_expected_system.txt'),
    judge: readPrompt('extract_juez_system.txt')
};
const COVER = 'Caratula de prueba para tramites de la autoridad financiera con documentos adjuntos listados.';
const OFICIO = 'Oficio judicial de prueba. CITE 100/2025. Demandante Persona de Prueba. Juez Juan Perez.';
const CONTINUACION = 'Continuacion de la tabla de demandados del oficio anterior, sin sello de recepcion.';

const originalCreate = openai.chat.completions.create;
const originalWarn = logger.warn;
const originalInfo = logger.info;
const originalSuccess = logger.success;
const originalConcurrency = config.concurrency;
const originalRetryDelayMs = config.retryDelayMs;
const originalManualCodeConfirmationsFile = config.manualCodeConfirmationsFile;

beforeEach(() => {
    config.concurrency = 2;
    config.retryDelayMs = 1;
});

afterEach(() => {
    openai.chat.completions.create = originalCreate;
    logger.warn = originalWarn;
    logger.info = originalInfo;
    logger.success = originalSuccess;
    config.concurrency = originalConcurrency;
    config.retryDelayMs = originalRetryDelayMs;
    config.manualCodeConfirmationsFile = originalManualCodeConfirmationsFile;
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
        if (formatName === 'adjunto_extraction' || formatName === 'adjunto_continuacion') {
            assert.equal(request.model, config.textModel);
            calls.extract++;
            calls.extractTexts.push(request.messages[1].content);
            activeExtract++;
            calls.maxActiveExtract = Math.max(calls.maxActiveExtract, activeExtract);
            await delay(10);
            activeExtract--;
            return completion(JSON.stringify(formatName === 'adjunto_continuacion'
                ? { demandados: [], juez: '', juzgado: '', tipo_documento_respaldo: '', nro_documento_respaldo: '', monto_retenido: '', moneda: '' }
                : { nro_cite: 'CITE 100/2025', demandante: 'Persona de Prueba', juez: 'Juan Perez' }));
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
            const readNumber = calls.id.filter(item => item === page).length;
            return completion(readNumber > 3
                ? (spec.cropped ?? spec.verify ?? spec.id ?? codeInText ?? 'NO_ENCONTRADO')
                : readNumber > 1
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

async function diagnose(tiffPath) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-diagnostic-test-'));
    try {
        return (await processFile(tiffPath, outputDir, { diagnostic: true })).extractedData;
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

async function run(tiffPath = fixture) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ocr-engine-'));
    try {
        const result = await processFile(tiffPath, outputDir);
        return { ...result, visionText: fs.readFileSync(result.outputPath, 'utf-8') };
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

describe('processFile', () => {
    it('marca error si la extraccion de caratula falla y no acepta una lista vacia', async () => {
        mockOpenAI(null, { 1: { text: COVER } });

        const data = (await run()).extractedData;

        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.equal('tiene_errores' in data, false);
        assert.equal('errores_bloqueantes' in data, false);
        assert.match(data.advertencias.join(' '), /Extraccion de caratula incompleta/);
        assert.match(data.motivos_incompleto.join(' '), /Caratula/);
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
            assert.equal(sirefo.estado_procesamiento, 'completo');
            assert.deepEqual(sirefo.documentos_adjuntos, [externalAdjunto]);
            assert.equal(sirefo.codigos_no_encontrados, undefined);
            assert.match(sirefo.advertencias.join(' '), /no incluido/);

            mockOpenAI([externalAdjunto], { 1: { text: COVER } });
            const ordinary = (await run(onePageTiff)).extractedData;
            assert.equal(ordinary.es_sirefo, false);
            assert.equal(ordinary.estado_procesamiento, 'incompleto');
            assert.deepEqual(ordinary.codigos_no_encontrados, ['SIN_CODIGO']);

            mockOpenAI(['R-12345'], { 1: { text: sirefoCover } });
            const missingCode = (await run(onePageTiff)).extractedData;
            assert.equal(missingCode.estado_procesamiento, 'incompleto');
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

        assert.equal(data.estado_procesamiento, 'completo');
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

    it('completa fecha y ciudad del cierre sin reemplazar el cite de la primera pagina', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: 'OTROSI.\nOruro, 25 de septiembre de 2025.\n[FIRMA]\nAbogado del caso.' },
            4: { text: 'SENTENCIA INICIAL No 089/2025-MOEJ\nOruro, 02 de octubre de 2025\n[FIRMA]' }
        });

        const data = (await run()).extractedData;
        const adjunto = data.ubicacion_adjuntos[0];

        assert.equal(data.estado_procesamiento, 'completo');
        assert.equal(adjunto.nro_cite, 'CITE 100/2025');
        assert.equal(adjunto.fecha_cite, '2025-09-25');
        assert.equal(adjunto.ciudad_cite, 'Oruro');
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

        assert.equal(data.estado_procesamiento, 'completo');
        // 12 paginas despues del sello: 11 con texto y la 8 en blanco.
        assert.deepEqual(data.ubicacion_adjuntos.map(a => [a.pagina, a.paginas_continuacion]), [[2, 11]]);
        assert.ok([3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14].every(page => sent.includes(`Fila ${page}.`)));
        assert.ok([3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14].every(page => result.visionText.includes(`Fila ${page}.`)));
        assert.match(result.visionText, /PAGINA 14 \/ 14 - CONTINUACION DE R-12345/);
        assert.equal(result.success, 14);
        assert.equal(data.paginas_omitidas, 1);
    });

    it('rechaza un OCR vacio cuando la imagen contiene trazos', async () => {
        const calls = mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: '' }
        });

        const result = await run(inkFixture);

        assert.equal(result.extractedData.estado_procesamiento, 'incompleto');
        assert.equal(result.errors, 1);
        assert.equal(calls.id.includes(3), false);
        assert.equal(calls.ocr.filter(call => call.page === 3).length, 2);
    });

    it('repite una vez un OCR vacio en una pagina con tinta', async () => {
        const calls = mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { ocr: attempt => completion(attempt === 1 ? '' : CONTINUACION) }
        });

        const result = await run(inkFixture);

        assert.equal(result.errors, 0);
        assert.equal(calls.ocr.filter(call => call.page === 3).length, 2);
        assert.equal(result.extractedData.ubicacion_adjuntos[0].paginas_continuacion, 1);
    });

    it('acepta el TIFF y avisa cuando una continuacion escribe distinto al juez', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: CONTINUACION }
        });
        const mocked = openai.chat.completions.create;
        openai.chat.completions.create = (request, options) =>
            request.response_format?.json_schema?.name === 'adjunto_continuacion'
                ? completion(JSON.stringify({ demandados: [], juez: 'Abg. Juan Perez', juzgado: '', tipo_documento_respaldo: '', nro_documento_respaldo: '', monto_retenido: '', moneda: '' }))
                : mocked(request, options);

        const data = (await run(inkFixture)).extractedData;

        assert.equal(data.estado_procesamiento, 'completo');
        assert.equal(data.ubicacion_adjuntos[0].juez, 'Juan Perez');
        assert.match(data.advertencias.join(' '), /juez o juzgado escrito distinto entre paginas: R-12345/);
    });

    it('requiere revision cuando dos paginas indican jueces realmente distintos', async () => {
        const logLines = [];
        logger.warn = message => { logLines.push(message); originalWarn(message); };
        logger.info = message => { logLines.push(message); originalInfo(message); };
        logger.success = message => { logLines.push(message); originalSuccess(message); };
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: CONTINUACION }
        });
        const mocked = openai.chat.completions.create;
        openai.chat.completions.create = (request, options) =>
            request.response_format?.json_schema?.name === 'adjunto_continuacion'
                ? completion(JSON.stringify({ demandados: [], juez: 'Carlos Gomez', juzgado: '', tipo_documento_respaldo: '', nro_documento_respaldo: '', monto_retenido: '', moneda: '' }))
                : mocked(request, options);

        const result = await run(inkFixture);
        const data = result.extractedData;

        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.equal('requiere_revision' in data, false);
        assert.equal(data.ubicacion_adjuntos[0]._error, undefined);
        assert.match(data.ubicacion_adjuntos[0]._revision, /juez/);
        assert.match(data.ubicacion_adjuntos[0]._conflictos.join(' '), /Carlos Gomez/);
        assert.match(data.motivos_incompleto.join(' '), /R-12345: .*juez \(valores en _conflictos\)/);
        assert.match(data.advertencias.join(' '), /Campos del mismo proceso contradictorios entre fragmentos: juez/);
        assert.match(result.visionText, /ESTADO DE PROCESAMIENTO: INCOMPLETO/);
        assert.match(logLines.join(' '), /\[AVANCE\] 1\/1 R-12345 INCOMPLETO: .*juez; pagina 2, 0 demandado\(s\), campos: nro_cite, demandante, juez/);
        // rpa.log persiste en texto plano: nombra campos, nunca sus valores.
        for (const value of ['Carlos Gomez', 'Juan Perez', 'Persona de Prueba', 'CITE 100/2025']) {
            assert.equal(logLines.some(line => line.includes(value)), false, value);
        }
    });

    it('recupera el juez sin escribir su nombre ni otros valores extraidos en el log', async () => {
        const logLines = [];
        logger.info = message => { logLines.push(message); originalInfo(message); };
        logger.warn = message => { logLines.push(message); originalWarn(message); };
        logger.success = message => { logLines.push(message); originalSuccess(message); };
        mockOpenAI(['R-12345 DE NOMBRE RESERVADO'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` }
        });
        const mockedCreate = openai.chat.completions.create;
        openai.chat.completions.create = request => {
            if (request.response_format?.json_schema?.name === 'adjunto_extraction') {
                return completion(JSON.stringify({
                    nro_cite: 'CITE 100/2025',
                    demandante: 'Persona Reservada',
                    demandados: [],
                    juez: ''
                }));
            }
            if (request.messages[0].content === SYSTEM.judge) return completion('Maria Prueba Lopez');
            return mockedCreate(request);
        };

        const data = (await run()).extractedData;

        assert.equal(data.ubicacion_adjuntos[0].juez, 'Maria Prueba Lopez');
        for (const value of ['NOMBRE RESERVADO', 'Persona Reservada', 'Maria Prueba Lopez', 'CITE 100/2025']) {
            assert.equal(logLines.some(line => line.includes(value)), false, value);
        }
    });

    it('lista los codigos no encontrados sin escribir la descripcion de la caratula en el log', async () => {
        const logLines = [];
        logger.info = message => { logLines.push(message); originalInfo(message); };
        logger.warn = message => { logLines.push(message); originalWarn(message); };
        mockOpenAI(['R-12345', 'R-54321 DE NOMBRE RESERVADO'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: CONTINUACION }
        });

        const data = (await run()).extractedData;

        assert.deepEqual(data.codigos_no_encontrados, ['R-54321']);
        assert.ok(logLines.some(line => line.includes('x R-54321')));
        assert.equal(logLines.some(line => line.includes('NOMBRE RESERVADO')), false);
    });

    it('acepta como en blanco una pagina con motas del escaner y OCR vacio', async () => {
        const calls = mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: '' }
        });

        const result = await run(speckledFixture);

        assert.equal(result.errors, 0);
        assert.equal(result.extractedData.estado_procesamiento, 'completo');
        assert.equal(calls.ocr.filter(call => call.page === 3).length, 2);
    });

    it('no clasifica como vacia una pagina grande con un codigo R pequeño', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ocr-small-code-'));
        const imagePath = path.join(tempDir, 'small-code.png');
        const code = Buffer.from('<svg width="250" height="45"><text x="2" y="24" font-size="20" font-family="DejaVu Sans" fill="black">R-12345</text></svg>');

        try {
            await sharp({ create: { width: 2536, height: 3914, channels: 3, background: 'white' } })
                .composite([{ input: code, left: 120, top: 150 }])
                .png()
                .toFile(imagePath);

            assert.equal(await isVisuallyBlankPage(imagePath, 0), false);
            assert.equal(await isVisuallyBlankPage(speckledFixture, 2), true);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('detiene el adjunto ante un oficio distinto sin codigo R y exige revision', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\nCITE 100/2025\n${OFICIO}` },
            3: { text: 'OFICIO Nro. 999/2025\nDocumento independiente sin sello R.' }
        });

        const result = await run(inkFixture);
        const data = result.extractedData;

        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.deepEqual(data.paginas_documento_no_identificado, [{ pagina: 3, identificador: '999/2025' }]);
        assert.match(result.visionText, /PAGINAS TRANSCRITAS SIN ADJUNTO ASIGNADO:[\s\S]*Documento independiente sin sello R/);
        assert.deepEqual(data.paginas_sin_asignar, [{ pagina: 3, texto: 'OFICIO Nro. 999/2025\nDocumento independiente sin sello R.' }]);
    });

    it('mantiene una continuacion que repite el mismo CITE', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\nCITE 100/2025\n${OFICIO}` },
            3: { text: `CITE 100/2025\n${CONTINUACION}` }
        });

        const result = await run(inkFixture);

        assert.equal(result.extractedData.estado_procesamiento, 'completo');
        assert.equal(result.extractedData.paginas_documento_no_identificado, undefined);
        assert.match(result.visionText, /PAGINA 3 \/ 3 - CONTINUACION DE R-12345/);
    });

    it('requiere revision si aparece otro encabezado sin identificador legible', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\nCITE 100/2025\n${OFICIO}` },
            3: { text: 'OFICIO\nSeñores: nuevo documento sin numero visible.' }
        });

        const data = (await run(inkFixture)).extractedData;

        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.deepEqual(data.paginas_documento_no_identificado, [
            { pagina: 3, identificador: 'OFICIO sin identificador legible' }
        ]);
    });

    it('incluye resoluciones de respaldo dentro de la continuación', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\nCITE 100/2025\n${OFICIO}` },
            3: { text: 'Sistema de Registro Judicial SIREJ\nRESOLUCIÓN Nro. 86/2025\nSENTENCIA INICIAL' }
        });

        const data = (await run(inkFixture)).extractedData;

        assert.equal(data.estado_procesamiento, 'completo');
        assert.equal(data.paginas_documento_no_identificado, undefined);
        assert.equal(data.ubicacion_adjuntos[0].paginas_continuacion, 1);
    });

    it('usa la imagen cuando el texto no muestra el codigo y rescata pendientes con identificacion dirigida', async () => {
        const calls = mockOpenAI(['R-12345', 'R-54321'], {
            1: { text: COVER },
            2: { text: OFICIO, id: 'R-12345' },
            3: { text: OFICIO, targeted: 'R-54321', verify: 'R-54321' }
        });

        const result = await run();
        const data = result.extractedData;

        assert.equal(data.estado_procesamiento, 'completo');
        assert.deepEqual(data.ubicacion_adjuntos.map(a => [a.pagina, a.id_buscado, a.id_encontrado]), [
            [2, 'R-12345', 'R-12345'],
            [3, 'R-54321', 'R-54321']
        ]);
        // Las páginas realmente blancas no necesitan una llamada de ID.
        assert.deepEqual([...new Set(calls.id)].sort((a, b) => a - b), [2, 3]);
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

        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.deepEqual(data.codigos_no_verificados, [
            { pagina: 2, esperado: 'R-12345', lectura_visual: 'R-12346' }
        ]);
        assert.equal(data.ubicacion_adjuntos[0].codigo_verificado, false);
    });

    it('el diagnostico omite verificaciones visuales y nunca marca el TIFF como completo', async () => {
        const calls = mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: CONTINUACION }
        });
        const mockedCreate = openai.chat.completions.create;
        openai.chat.completions.create = request => {
            if (request.messages[0].content === SYSTEM.id && pageOf(request) === 3) {
                throw new CacheOnlyMissError('Diagnostico sin API: respuesta negativa de ID no guardada');
            }
            return mockedCreate(request);
        };
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-diagnostic-test-'));
        try {
            const data = (await processFile(fixture, outputDir, { diagnostic: true })).extractedData;
            assert.equal(data.estado_procesamiento, 'incompleto');
            assert.equal(data._auditoria.diagnostico_sin_api, true);
            assert.equal(data._auditoria.identificaciones_sin_cache, 1);
            assert.equal(data.ubicacion_adjuntos[0].codigo_verificado, false);
            assert.deepEqual(calls.id, []);
        } finally {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }
    });

    it('el diagnostico reconoce sin API una pagina en blanco que no esta en cache', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` }
        });
        const mockedCreate = openai.chat.completions.create;
        // La cache nunca guarda la respuesta vacia de una pagina en blanco.
        openai.chat.completions.create = request => {
            if (request.messages[0].content === SYSTEM.ocr && pageOf(request) === 3) {
                throw new CacheOnlyMissError('Diagnostico sin API: respuesta no disponible en cache (prueba)');
            }
            return mockedCreate(request);
        };

        const data = await diagnose(speckledFixture);

        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.equal(data.ubicacion_adjuntos[0].demandante, 'Persona de Prueba');
        assert.deepEqual(data.motivos_incompleto, ['Diagnostico de cache: codigos R sin nueva verificacion visual']);
    });

    it('el diagnostico deja pendiente solo la pagina con tinta que falta en cache', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: CONTINUACION }
        });
        const mockedCreate = openai.chat.completions.create;
        openai.chat.completions.create = request => {
            if (request.messages[0].content === SYSTEM.ocr && pageOf(request) === 3) {
                throw new CacheOnlyMissError('Diagnostico sin API: respuesta no disponible en cache (prueba)');
            }
            return mockedCreate(request);
        };

        const data = await diagnose(inkFixture);

        assert.equal(data.ubicacion_adjuntos[0].demandante, 'Persona de Prueba');
        assert.match(data.motivos_incompleto.join(' '), /lectura fallida en pagina\(s\) 3\)/);
    });

    it('el diagnostico conserva los demas adjuntos cuando falta una extraccion en cache', async () => {
        const calls = mockOpenAI(['R-12345', 'R-54321'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}` },
            3: { text: CONTINUACION },
            4: { text: `ASFI RECEPCION R-54321\n${OFICIO}` },
            5: { text: CONTINUACION },
            6: { text: `ASFI RECEPCION R-77777\n${OFICIO}`, id: 'R-77777' }
        });
        const mockedCreate = openai.chat.completions.create;
        openai.chat.completions.create = request => {
            if (request.response_format?.json_schema?.name === 'adjunto_extraction' && request.messages[1].content.includes('R-12345')) {
                throw new CacheOnlyMissError('Diagnostico sin API: respuesta no disponible en cache (prueba)');
            }
            return mockedCreate(request);
        };

        const data = await diagnose(fixture);
        const [first, second] = data.ubicacion_adjuntos;

        assert.equal(first.id_buscado, 'R-12345');
        assert.match(first._error, /^Fragmento 1\/2: Diagnostico sin API/);
        assert.equal(second.id_buscado, 'R-54321');
        assert.equal(second._error, undefined);
        assert.equal(second.demandante, 'Persona de Prueba');
        assert.equal(calls.extract, 2);
    });

    it('resuelve una lectura visual discordante con una lectura adicional', async () => {
        const calls = mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: `ASFI RECEPCION R-12345\n${OFICIO}`, id: 'R-12346', verify: 'R-12345' }
        });

        const data = (await run()).extractedData;

        assert.equal(data.estado_procesamiento, 'completo');
        assert.equal(data.ubicacion_adjuntos[0].codigo_verificado, true);
        assert.equal(data.ubicacion_adjuntos[0].codigo_lectura_visual, 'R-12346');
        assert.equal(data.ubicacion_adjuntos[0].codigo_lectura_adicional, 'R-12345');
        assert.equal(calls.id.filter(page => page === 2).length, 2);
    });

    it('exige revision cuando el recorte coincide pero dos lecturas completas discrepan', async () => {
        const calls = mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: OFICIO, id: 'R-12346', cropped: 'R-12345' }
        });

        const data = (await run()).extractedData;
        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.equal(data.ubicacion_adjuntos[0].codigo_verificado, false);
        assert.equal(data.ubicacion_adjuntos[0].id_encontrado, 'R-12346');
        assert.equal(data.ubicacion_adjuntos[0].confianza, 0.8);
        assert.match(data.ubicacion_adjuntos[0]._advertencia_match_aproximado, /Revisar manualmente/);
        assert.equal(data.ubicacion_adjuntos[0].codigo_lectura_recorte, 'R-12345');
        assert.equal(calls.id.filter(page => page === 2).length, 4);
    });

    it('acepta una confirmacion humana del TIFF exacto y deja trazabilidad', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-manual-confirmation-'));
        config.manualCodeConfirmationsFile = path.join(tempDir, 'confirmations.jsonl');
        try {
            const entry = await recordManualCodeConfirmation(fixture, 2, 'R-12345', config.manualCodeConfirmationsFile);
            const calls = mockOpenAI(['R-12345'], {
                1: { text: COVER },
                2: { text: OFICIO, id: 'R-12346' }
            });

            const data = (await run()).extractedData;
            const adjunto = data.ubicacion_adjuntos[0];
            assert.equal(data.estado_procesamiento, 'completo');
            assert.equal(adjunto.id_encontrado, 'R-12346');
            assert.equal(adjunto.codigo_verificado, true);
            assert.equal(adjunto.codigo_verificacion_fuente, 'manual');
            assert.deepEqual(data._auditoria.confirmaciones_manuales, [{ pagina: 2, codigo: 'R-12345' }]);
            assert.equal(data._auditoria.hash_archivo_sha256, entry.hash_archivo_sha256);
            assert.equal(calls.id.filter(page => page === 2).length, 1);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rechaza confirmaciones para otro TIFF o contradictorias en la misma pagina', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-manual-conflict-'));
        config.manualCodeConfirmationsFile = path.join(tempDir, 'confirmations.jsonl');
        try {
            const entry = await recordManualCodeConfirmation(fixture, 2, 'R-12345', config.manualCodeConfirmationsFile);
            await assert.rejects(
                recordManualCodeConfirmation(fixture, 2, 'R-12346', config.manualCodeConfirmationsFile),
                /confirmacion distinta/
            );
            mockOpenAI(['R-12345'], {
                1: { text: COVER },
                2: { text: OFICIO, id: 'R-12346' }
            });

            const otherTiff = (await run(longFixture)).extractedData;
            assert.equal(otherTiff.estado_procesamiento, 'incompleto');
            assert.equal(otherTiff.ubicacion_adjuntos[0].codigo_verificado, false);

            fs.appendFileSync(config.manualCodeConfirmationsFile,
                `${JSON.stringify({ ...entry, codigo: 'R-12346' })}\n`);
            const conflicting = (await run()).extractedData;
            assert.equal(conflicting.estado_procesamiento, 'incompleto');
            assert.equal(conflicting.ubicacion_adjuntos[0].codigo_verificado, false);
            assert.deepEqual(conflicting._auditoria.confirmaciones_manuales, []);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('mantiene la revision cuando una aproximacion no obtiene confirmacion visual', async () => {
        mockOpenAI(['R-12345'], {
            1: { text: COVER },
            2: { text: OFICIO, id: 'R-12346' }
        });

        const data = (await run()).extractedData;
        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.equal(data.ubicacion_adjuntos[0].codigo_verificado, false);
        assert.match(data.ubicacion_adjuntos[0]._advertencia_match_aproximado, /Revisar manualmente/);
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
        assert.equal(data.estado_procesamiento, 'incompleto');
        assert.deepEqual(data.ubicacion_adjuntos.map(a => a.id_buscado), ['R-12345']);
        assert.deepEqual(data.codigos_no_encontrados, ['R-54321']);
    });
});
