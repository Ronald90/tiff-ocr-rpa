import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import openai from '../openai-client.js';
import { extractAdjuntoFields } from '../adjunto-extractor.js';

const originalCreate = openai.chat.completions.create;
const ocrText = 'ASFI RECEPCION R-12345. CITE 100/2025. Demandante Persona de Prueba. Juez Juan Perez.';

afterEach(() => {
    openai.chat.completions.create = originalCreate;
});

describe('reintentos de extraccion', () => {
    it('repite una salida truncada una sola vez con el doble de tokens', async () => {
        const caps = [];
        openai.chat.completions.create = async request => {
            caps.push(request.max_completion_tokens);
            return { choices: [{ finish_reason: 'length', message: { content: '{' } }] };
        };

        const result = await extractAdjuntoFields(ocrText);
        assert.deepEqual(caps, [16000, 32000]);
        assert.match(result._error, /truncada/);
    });

    it('recupera el resultado cuando el segundo intento cabe', async () => {
        const caps = [];
        openai.chat.completions.create = async request => {
            caps.push(request.max_completion_tokens);
            if (caps.length === 1) return { choices: [{ finish_reason: 'length', message: { content: '{' } }] };
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ nro_cite: '100/2025' }) } }] };
        };

        const result = await extractAdjuntoFields(ocrText);
        assert.deepEqual(caps, [16000, 32000]);
        assert.equal(result.nro_cite, '100/2025');
        assert.equal(result._error, undefined);
    });

    it('no repite una solicitud invalida', async () => {
        let calls = 0;
        openai.chat.completions.create = async () => {
            calls++;
            throw Object.assign(new Error('400 Invalid request'), { status: 400 });
        };

        const result = await extractAdjuntoFields(ocrText);
        assert.equal(calls, 1);
        assert.match(result._error, /Invalid request/);
    });
});
