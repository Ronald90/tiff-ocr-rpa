import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import openai from '../openai-client.js';
import config from '../config.js';
import {
    extractAdjuntoFields,
    extractJuezFallback,
    normalizeTipoProcesoValue,
    extractExplicitTipoProcesoFallback,
    normalizeJuezValue
} from '../adjunto-extractor.js';

const originalCreate = openai.chat.completions.create;
const originalChunkChars = config.adjuntoChunkChars;
afterEach(() => {
    openai.chat.completions.create = originalCreate;
    config.adjuntoChunkChars = originalChunkChars;
});

function longAdjuntoText() {
    return `INICIO_UNICO\n${'Fila de tabla sin datos individuales.\n'.repeat(800)}FINAL_UNICO\n`;
}

describe('extraccion de adjuntos largos', () => {
    it('envia todos los fragmentos y une demandados del comienzo y del final', async () => {
        config.adjuntoChunkChars = 24000;
        const sent = [];
        openai.chat.completions.create = async request => {
            const content = request.messages[1].content;
            const fragment = content.match(/<<<FRAGMENTO>>>\n([\s\S]*?)\n<<<FIN FRAGMENTO>>>/)?.[1] || content;
            assert.equal(request.response_format?.json_schema?.name,
                sent.length === 0 ? 'adjunto_extraction' : 'adjunto_continuacion');
            sent.push(fragment);
            const nombre = fragment.includes('INICIO_UNICO') ? 'Primero' :
                fragment.includes('FINAL_UNICO') ? 'Ultimo' : '';
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                nro_cite: 'CITE 100/2025',
                demandados: nombre ? [{ nombre, nro_documento: nombre === 'Primero' ? '1' : '2' }] : []
            }) } }] };
        };

        const result = await extractAdjuntoFields(longAdjuntoText());

        assert.ok(sent.length > 1);
        assert.equal(sent.filter(value => value.includes('INICIO_UNICO')).length, 1);
        assert.equal(sent.filter(value => value.includes('FINAL_UNICO')).length, 1);
        assert.ok(sent.every(value => !value.includes('texto restante omitido')));
        assert.deepEqual(result.demandados.map(item => item.nombre), ['Primero', 'Ultimo']);
        assert.equal(result._fragmentos_extraccion, sent.length);
        assert.equal(result._error, undefined);
    });

    it('marca error si falla un fragmento intermedio', async () => {
        config.adjuntoChunkChars = 24000;
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            if (calls === 2) throw Object.assign(new Error('400 Invalid request'), { status: 400 });
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ demandados: [] }) } }] };
        };

        const result = await extractAdjuntoFields(longAdjuntoText());

        assert.equal(calls, 2);
        assert.match(result._error, /Fragmento 2\/\d+: 400 Invalid request/);
    });

    it('conserva los campos del documento principal aunque otro fragmento tenga otro cite', async () => {
        config.adjuntoChunkChars = 24000;
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                nro_cite: calls === 1 ? '100/2025' : '101/2025',
                demandados: []
            }) } }] };
        };

        const result = await extractAdjuntoFields(longAdjuntoText());

        assert.equal(calls, 2);
        assert.equal(result.nro_cite, '100/2025');
        assert.equal(result._error, undefined);
    });

    it('no marca contradiccion por mayusculas o tildes ni por un oficio citado dentro de la tabla', async () => {
        config.adjuntoChunkChars = 24000;
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                juez: calls === 1 ? 'Juan Pérez' : 'JUAN PEREZ',
                demandados: []
            }) } }] };
        };
        const text = `Oficio Nro. 100/2025\n${longAdjuntoText()}Ver Oficio Nro. 999/2025 de la fila anterior.\n`;

        const result = await extractAdjuntoFields(text);

        assert.equal(calls, 2);
        assert.equal(result._error, undefined);
        assert.equal(result.juez, 'Juan Pérez');
        // El respaldo por regex solo lee el primer fragmento, que es el principal.
        assert.equal(result.nro_cite, '100/2025');
    });

    it('aisla la pagina R aun cuando el documento de respaldo cabe en el mismo fragmento', async () => {
        const principal = 'PAGINA R-241594\nDEMANDANTE: BANCO UNION S.A.\nDEMANDADO: FAUSTINA CORIA MAMANI C.I. 4079866\n';
        const respaldo = 'RESOLUCION DEL MISMO PROCESO R-241594\nJUEZ: Pedro Perez\nOFICIO DE OTRO PROCESO\nOf. Nro. 999/2025\nDEMANDADO: PERSONA DE OTRO PROCESO\n';
        const sent = [];
        openai.chat.completions.create = async request => {
            const content = request.messages[1].content;
            sent.push(content);
            if (request.response_format?.json_schema?.name === 'adjunto_extraction') {
                return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                    demandante: 'BANCO UNION S.A.',
                    demandados: [{ nombre: 'FAUSTINA CORIA MAMANI', nro_documento: '4079866' }]
                }) } }] };
            }
            assert.deepEqual(request.response_format.json_schema.schema.required, [
                'demandados', 'juez', 'juzgado', 'tipo_documento_respaldo',
                'nro_documento_respaldo', 'monto_retenido', 'moneda'
            ]);
            assert.match(request.messages[0].content, /MISMO proceso principal/);
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                juez: 'Pedro Perez',
                demandados: [{ nombre: 'FAUSTINA CORIA MAMANI', nro_documento: '4079866', tipo_documento: 'CI' }]
            }) } }] };
        };

        const result = await extractAdjuntoFields(principal + '\n\n' + respaldo, { primaryText: principal });

        assert.equal(sent.length, 2);
        assert.ok(sent[0].includes('PAGINA R-241594'));
        assert.ok(!sent[0].includes('OFICIO DE OTRO PROCESO'));
        assert.ok(sent[1].includes('OFICIO DE OTRO PROCESO'));
        assert.equal(result.demandante, 'BANCO UNION S.A.');
        assert.equal(result.nro_cite, '');
        assert.equal(result.juez, 'Pedro Perez');
        assert.deepEqual(result.demandados.map(item => item.nombre), ['FAUSTINA CORIA MAMANI']);
        assert.equal(result.demandados[0].tipo_documento, 'CI');
        assert.equal(result._error, undefined);
    });

    it('marca una diferencia real del mismo demandado para revision', async () => {
        const principal = 'PAGINA R-241594\nDEMANDADO: ANA PEREZ C.I. 1234567\nMONTO: Bs. 100,00\n';
        const continuacion = 'RESOLUCION DEL MISMO PROCESO\nANA PEREZ C.I. 1234567\nMONTO: Bs. 200,00\n';
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            const monto = calls === 1 ? '100,00' : '200,00';
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                demandados: [{ nombre: 'ANA PEREZ', tipo_documento: 'CI', nro_documento: '1234567', monto }]
            }) } }] };
        };

        const result = await extractAdjuntoFields(principal + '\n\n' + continuacion, { primaryText: principal });

        assert.equal(result.demandados.length, 1);
        assert.equal(result.demandados[0].monto, '100,00');
        assert.match(result._error, /demandados\.monto/);
    });

    it('mantiene como filas distintas a la misma persona con otra resolucion', async () => {
        const principal = 'PAGINA R-241594\nCOBRANZA COACTIVA AL NIT 1234567 POR DOS RESOLUCIONES DETERMINATIVAS\n';
        openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            demandados: [
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: 'RD 10/2025', monto: '1.000,00' },
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: 'RD 11/2025', monto: '2.500,00' }
            ]
        }) } }] });

        const result = await extractAdjuntoFields(principal, { primaryText: principal });

        assert.deepEqual(result.demandados.map(item => [item.resolucion, item.monto]), [
            ['RD 10/2025', '1.000,00'],
            ['RD 11/2025', '2.500,00']
        ]);
        assert.equal(result._error, undefined);
    });

    it('asocia una fila sin resolucion solo cuando su monto identifica una fila unica', async () => {
        const principal = 'PAGINA R-241594\nCOBRANZA COACTIVA AL NIT 1234567 POR DOS RESOLUCIONES DETERMINATIVAS\n';
        openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            demandados: [
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: 'RD 10/2025', monto: '1.000,00' },
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: 'RD 11/2025', monto: '2.500,00' },
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: '', monto: 'Bs. 2.500,00' }
            ]
        }) } }] });

        const result = await extractAdjuntoFields(principal, { primaryText: principal });

        assert.equal(result._error, undefined);
        assert.deepEqual(result.demandados.map(item => [item.resolucion, item.monto]), [
            ['RD 10/2025', '1.000,00'],
            ['RD 11/2025', '2.500,00']
        ]);
    });

    it('exige revision si una fila sin resolucion coincide con varias resoluciones', async () => {
        const principal = 'PAGINA R-241594\nCOBRANZA COACTIVA AL NIT 1234567 POR DOS RESOLUCIONES DETERMINATIVAS\n';
        openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            demandados: [
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: 'RD 10/2025', monto: '1.000,00' },
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: 'RD 11/2025', monto: '1.000,00' },
                { nombre: 'JUAN PEREZ', tipo_documento: 'NIT', nro_documento: '1234567', resolucion: '', monto: '1.000,00' }
            ]
        }) } }] });

        const result = await extractAdjuntoFields(principal, { primaryText: principal });

        assert.match(result._error, /demandados\.resolucion_ambigua/);
    });

    it('compara montos por su valor y no por su formato', async () => {
        const principal = 'PAGINA R-241594\nRETENGASE Bs. 89.516,17\nDEMANDADO: ANA PEREZ C.I. 1234567 POR Bs. 1.000\n';
        const continuacion = 'DETALLE DEL MISMO PROCESO\nANA PEREZ C.I. 1234567 1000,00\nTOTAL A RETENER 89.516,17\n';
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                monto_retenido: calls === 1 ? '89.516,17' : 'Bs. 89.516,17',
                demandados: [{ nombre: 'ANA PEREZ', tipo_documento: 'CI', nro_documento: '1234567', monto: calls === 1 ? '1.000' : '1000,00' }]
            }) } }] };
        };

        const result = await extractAdjuntoFields(principal + '\n\n' + continuacion, { primaryText: principal });

        assert.equal(calls, 2);
        assert.equal(result._error, undefined);
        assert.equal(result.monto_retenido, '89.516,17');
        assert.equal(result.demandados.length, 1);
    });

    it('avisa sin bloquear por titulo profesional u ordinal equivalente', async () => {
        const principal = 'PAGINA R-241594\nJUZGADO PUBLICO CIVIL Y COMERCIAL 3º\n[FIRMA]\nJuan Perez\nJUEZ PUBLICO CIVIL Y COMERCIAL TERCERO\n';
        const continuacion = 'ACTUACION DEL MISMO PROCESO\nAbg. Juan Perez\nJUEZ PUBLICO CIVIL Y COMERCIAL TERCERO\n';
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls === 1
                ? { juez: 'Juan Perez', juzgado: 'JUZGADO PUBLICO CIVIL Y COMERCIAL 3º', demandados: [] }
                : { juez: 'Abg. Juan Perez', juzgado: 'JUZGADO PUBLICO CIVIL Y COMERCIAL TERCERO', demandados: [] }) } }] };
        };

        const result = await extractAdjuntoFields(principal + '\n\n' + continuacion, { primaryText: principal });

        assert.equal(result._error, undefined);
        assert.equal(result.juez, 'Juan Perez');
        assert.equal(result.juzgado, 'JUZGADO PUBLICO CIVIL Y COMERCIAL 3º');
        assert.equal(result._advertencia_valores_distintos.length, 2);
    });

    it('bloquea jueces y juzgados realmente distintos', async () => {
        const principal = 'PAGINA R-241594\nJUZGADO PUBLICO CIVIL Y COMERCIAL 3º\n[FIRMA]\nMargarita Anez Tejerina\nJUEZ PUBLICO CIVIL Y COMERCIAL TERCERO\n';
        const continuacion = 'ACTUACION DEL MISMO PROCESO\nAbg. Alberto Llanos Martinez\nJUEZ PUBLICO CIVIL Y COMERCIAL CUARTO\n';
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls === 1
                ? { juez: '', juzgado: 'JUZGADO PUBLICO CIVIL Y COMERCIAL 3º', demandados: [] }
                : { juez: 'Abg. Alberto Llanos Martinez', juzgado: 'JUZGADO PUBLICO CIVIL Y COMERCIAL CUARTO', demandados: [] }) } }] };
        };

        const result = await extractAdjuntoFields(principal + '\n\n' + continuacion, { primaryText: principal });

        assert.match(result._error, /juez/);
        assert.match(result._error, /juzgado/);
    });
});

describe('tipo_proceso handling', () => {
    it('limpia el valor devuelto por el modelo sin clasificarlo', () => {
        const value = 'REF: SOLICITA SUSPENSION DE RETENCION';
        assert.equal(normalizeTipoProcesoValue(value), 'SUSPENSION DE RETENCION');
    });

    it('extrae el tipo de proceso desde una etiqueta explicita', () => {
        const text = [
            'PROCESO: Ejecutivo',
            'NUREJ: 201142717',
            'DEMANDANTE: BANCO X'
        ].join('\n');

        assert.equal(extractExplicitTipoProcesoFallback(text), 'Ejecutivo');
    });

    it('extrae el tipo de proceso desde una frase del cuerpo del documento', () => {
        const text = [
            'Para su conocimiento y debido cumplimiento, comunico a Ud. que',
            'dentro del proceso EJECUTIVO seguido por DANIEL ALBERTO BEJARANO',
            'contra MAURICIO DANIEL ARIAS FLORES; EXP. 287-11'
        ].join('\n');

        assert.equal(extractExplicitTipoProcesoFallback(text), 'EJECUTIVO');
    });

    it('no usa la referencia como fallback deterministico cuando no hay proceso explicito', () => {
        const text = [
            'REF.: SOLICITA SUSPENSION DE RETENCION DE CUENTAS BANCARIAS Y FONDOS CUENTAS SAFI',
            'De nuestra consideracion:',
            'Mediante la presente se solicita la suspension de retencion de fondos de cuentas bancarias y fondos cuentas SAFI'
        ].join('\n');

        assert.equal(extractExplicitTipoProcesoFallback(text), '');
    });

    it('prioriza el proceso judicial explicito sobre la referencia del oficio', () => {
        const text = [
            'REF: CERTIFICACION.-',
            'Para su conocimiento y debido cumplimiento, comunico a Ud. que',
            'dentro del proceso EJECUTIVO seguido por DANIEL ALBERTO BEJARANO',
            'contra MAURICIO DANIEL ARIAS FLORES; EXP. 287-11'
        ].join('\n');

        assert.equal(extractExplicitTipoProcesoFallback(text), 'EJECUTIVO');
    });

    it('no confunde una referencia generica de certificacion con el tipo de proceso', () => {
        const text = [
            'REF: CERTIFICACION.-',
            'Oficio 729/2025',
            'Para su conocimiento y debido cumplimiento...'
        ].join('\n');

        assert.equal(extractExplicitTipoProcesoFallback(text), '');
    });
});

describe('juez handling', () => {
    it('limpia una salida del modelo que mezcla nombre y cargo del juez', () => {
        const value = 'Dra. Margarita Anez Tejerina JUEZ PUBLICO CIVIL-COMERCIAL DE LA CAPITAL 21°';
        assert.equal(normalizeJuezValue(value), 'Dra. Margarita Anez Tejerina');
    });

    it('limpia una salida del modelo que mezcla nombre y cargo de jueza', () => {
        const value = 'Dra. Greta Isabel Martinez Ramos JUEZA DE PARTIDO DE TRABAJO Y S.S.';
        assert.equal(normalizeJuezValue(value), 'Dra. Greta Isabel Martinez Ramos');
    });

    it('rechaza frases legales que no son nombre de juez', () => {
        assert.equal(normalizeJuezValue('DE VEJEZ O INVALIDEZ'), '');
        assert.equal(normalizeJuezValue('III. POR TANTO'), '');
        assert.equal(normalizeJuezValue('La suscrita'), '');
        assert.equal(normalizeJuezValue('FIRMA Y SELLO DE LA'), '');
        assert.equal(normalizeJuezValue('NO_ENCONTRADO'), '');
    });

    it('extrae el nombre del juez desde el bloque de firma', () => {
        const text = [
            'Con este motivo saludo a ustedes muy atentamente.-',
            '[FIRMA]',
            'Margarita Anez Tejerina',
            'JUEZ PUBLICO CIVIL-COMERCIAL DE LA CAPITAL 21°',
            'SANTA CRUZ - BOLIVIA'
        ].join('\n');

        assert.equal(extractJuezFallback(text), 'Margarita Anez Tejerina');
    });

    it('extrae Greta desde sello aunque antes haya texto de pensiones e invalidez', () => {
        const text = [
            'SALVO QUE SE TRATE DE CUENTAS DE CONVENIO PARA EL PAGO DE',
            'SUELDOS Y SALARIOS, PENSIONES, JUBILACIONES, MONTEPIOS, RENTAS',
            'DE VEJEZ O INVALIDEZ.',
            '[FIRMA]',
            'Dra. Greta Isabel Martinez Ramos',
            'JUEZA DE PARTIDO DE TRABAJO Y S.S.',
            'ADMINISTRATIVO, COACTIVO FISCAL Y TRIBUTARIO 1RO DE LA CAPITAL'
        ].join('\n');

        assert.equal(extractJuezFallback(text), 'Dra. Greta Isabel Martinez Ramos');
    });

    it('no confunde la firma de secretaria con el nombre del juez', () => {
        const text = [
            '[FIRMA]',
            'Maria Lopez Perez',
            'SECRETARIA - ABOGADA',
            'JUZGADO PUBLICO CIVIL-COMERCIAL 21°'
        ].join('\n');

        assert.equal(extractJuezFallback(text), '');
    });
});
