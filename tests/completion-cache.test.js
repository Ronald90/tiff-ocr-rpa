import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from '../logger.js';
import { cacheCompletions, withCacheOnly, withOpenAIUsage } from '../completion-cache.js';

const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function cacheDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-completion-cache-'));
    dirs.push(dir);
    return dir;
}

function completion(content, finishReason = 'stop') {
    return { choices: [{ finish_reason: finishReason, message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
}

it('reutiliza respuestas válidas entre ejecuciones y distingue cambios de solicitud', async () => {
    const dir = cacheDir();
    let calls = 0;
    const create = async () => completion(`respuesta ${++calls}`);
    const firstRun = cacheCompletions(create, dir);
    const request = { model: 'modelo-a', messages: [{ role: 'user', content: 'imagen-a' }] };

    assert.equal((await firstRun(request)).choices[0].message.content, 'respuesta 1');
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.cache')).length, 1);

    const secondRun = cacheCompletions(create, dir);
    assert.equal((await secondRun(request)).choices[0].message.content, 'respuesta 1');
    assert.equal(calls, 1);
    assert.equal((await secondRun({ ...request, messages: [{ role: 'user', content: 'imagen-b' }] })).choices[0].message.content, 'respuesta 2');
    assert.equal((await secondRun({ ...request, model: 'modelo-b' })).choices[0].message.content, 'respuesta 3');
    assert.equal(calls, 3);
});

it('no reutiliza una verificación con cacheMode off', async () => {
    const dir = cacheDir();
    let calls = 0;
    const create = async (_request, options) => {
        assert.equal(Object.hasOwn(options, 'cacheMode'), false);
        return completion(`lectura ${++calls}`);
    };
    const cached = cacheCompletions(create, dir);
    const request = { model: 'modelo', messages: [{ role: 'user', content: 'imagen' }] };

    assert.equal((await cached(request)).choices[0].message.content, 'lectura 1');
    assert.equal((await cached(request, { cacheMode: 'off' })).choices[0].message.content, 'lectura 2');
    assert.equal((await cached(request)).choices[0].message.content, 'lectura 1');
    assert.equal(calls, 2);
});

it('el diagnostico solo lee cache y nunca consulta la API ante faltantes', async () => {
    const dir = cacheDir();
    let calls = 0;
    const cached = cacheCompletions(async () => completion(`respuesta ${++calls}`), dir);
    const request = { model: 'modelo', messages: [{ role: 'user', content: 'imagen' }] };

    await assert.rejects(withCacheOnly(() => cached(request)), /Diagnostico sin API: respuesta no disponible en cache \([0-9a-f]{12}\)$/);
    assert.equal(calls, 0);
    await cached(request);
    assert.equal((await withCacheOnly(() => cached(request))).choices[0].message.content, 'respuesta 1');
    await assert.rejects(withCacheOnly(() => cached(request, { cacheMode: 'off' })), /Diagnostico sin API/);
    assert.equal(calls, 1);
});

it('no guarda respuestas truncadas ni JSON inválido y evita solicitudes simultáneas duplicadas', async () => {
    const dir = cacheDir();
    let calls = 0;
    const create = async () => {
        calls++;
        if (calls === 1) return completion('{', 'length');
        if (calls === 2) return completion('{');
        await new Promise(resolve => setTimeout(resolve, 10));
        return completion('{"campo":"ok"}');
    };
    const cached = cacheCompletions(create, dir);
    const request = {
        model: 'modelo',
        response_format: { type: 'json_schema' },
        messages: [{ role: 'user', content: 'texto' }]
    };

    await cached(request);
    await cached(request);
    assert.equal(fs.readdirSync(dir).length, 0);
    const results = await Promise.all([cached(request), cached(request)]);
    assert.equal(calls, 3);
    assert.equal(results[0].choices[0].message.content, '{"campo":"ok"}');
    assert.equal(results[1].choices[0].message.content, '{"campo":"ok"}');
});

it('vuelve a consultar una lectura NO_ENCONTRADO', async () => {
    const dir = cacheDir();
    let calls = 0;
    const cached = cacheCompletions(async () => completion(++calls === 1 ? 'NO_ENCONTRADO' : 'R-12345'), dir);
    const request = { model: 'modelo', messages: [{ role: 'user', content: 'imagen' }] };

    assert.equal((await cached(request)).choices[0].message.content, 'NO_ENCONTRADO');
    assert.equal((await cached(request)).choices[0].message.content, 'R-12345');
    assert.equal(calls, 2);
});

it('informa los tokens aunque el procesamiento del TIFF termine en error', async () => {
    const lines = [];
    const originalInfo = logger.info;
    logger.info = line => lines.push(line);
    try {
        const cached = cacheCompletions(async () => completion('R-12345'), cacheDir());
        const request = { model: 'modelo', messages: [{ role: 'user', content: 'imagen' }] };
        await assert.rejects(withOpenAIUsage('fallido.tif', async () => {
            await cached(request);
            await cached(request);
            throw new Error('validación fallida');
        }), /validación fallida/);

        assert.match(lines.join('\n'), /fallido\.tif: 1 llamada\(s\) reutilizada\(s\)/);
        assert.match(lines.join('\n'), /modelo: 1 llamada\(s\), 12 tokens entrada, 3 salida/);
    } finally {
        logger.info = originalInfo;
    }
});
