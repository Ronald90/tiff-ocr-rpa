import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sleep, renderPrompt, safeJsonParse, formatTime } from '../utils.js';

// ── renderPrompt ──────────────────────────────────────────────────────

describe('renderPrompt', () => {
    it('reemplaza un marcador simple', () => {
        const result = renderPrompt('Hola {{nombre}}', { nombre: 'Juan' });
        assert.equal(result, 'Hola Juan');
    });

    it('reemplaza múltiples marcadores', () => {
        const result = renderPrompt('{{a}} y {{b}}', { a: 'X', b: 'Y' });
        assert.equal(result, 'X y Y');
    });

    it('reemplaza múltiples ocurrencias del mismo marcador', () => {
        const result = renderPrompt('{{x}} + {{x}}', { x: '1' });
        assert.equal(result, '1 + 1');
    });

    it('deja texto intacto si no hay marcadores', () => {
        const result = renderPrompt('sin marcadores', {});
        assert.equal(result, 'sin marcadores');
    });

    it('convierte números a string', () => {
        const result = renderPrompt('Pagina {{num}}', { num: 5 });
        assert.equal(result, 'Pagina 5');
    });

    it('maneja vars vacíos', () => {
        const result = renderPrompt('{{vacio}} hola', { vacio: '' });
        assert.equal(result, ' hola');
    });
});

// ── safeJsonParse ─────────────────────────────────────────────────────

describe('safeJsonParse', () => {
    it('parsea JSON válido directo', () => {
        const result = safeJsonParse('{"a": 1}');
        assert.deepEqual(result, { a: 1 });
    });

    it('parsea JSON envuelto en texto', () => {
        const result = safeJsonParse('Aquí está el resultado: {"a": 1} fin');
        assert.deepEqual(result, { a: 1 });
    });

    it('parsea JSON con markdown code block', () => {
        const result = safeJsonParse('```json\n{"a": 1}\n```');
        assert.deepEqual(result, { a: 1 });
    });

    it('devuelve null para texto sin JSON', () => {
        const result = safeJsonParse('no hay json aqui');
        assert.equal(result, null);
    });

    it('devuelve null para JSON malformado', () => {
        const result = safeJsonParse('{a: 1}');
        assert.equal(result, null);
    });

    it('parsea JSON con arrays', () => {
        const result = safeJsonParse('{"items": [1, 2, 3]}');
        assert.deepEqual(result, { items: [1, 2, 3] });
    });

    it('parsea JSON complejo anidado', () => {
        const input = '{"a": {"b": [{"c": true}]}}';
        const result = safeJsonParse(input);
        assert.deepEqual(result, { a: { b: [{ c: true }] } });
    });
});

// ── formatTime ────────────────────────────────────────────────────────

describe('formatTime', () => {
    it('formatea solo segundos', () => {
        assert.equal(formatTime(45), '45s');
    });

    it('formatea minutos y segundos', () => {
        assert.equal(formatTime(125), '2m 5s');
    });

    it('formatea 0 segundos', () => {
        assert.equal(formatTime(0), '0s');
    });

    it('redondea decimales', () => {
        assert.equal(formatTime(45.7), '45s');
    });

    it('formatea exactamente 60 segundos como 1m 0s', () => {
        assert.equal(formatTime(60), '1m 0s');
    });
});

// ── sleep ─────────────────────────────────────────────────────────────

describe('sleep', () => {
    it('espera al menos el tiempo indicado', async () => {
        const start = Date.now();
        await sleep(50);
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 45, `Esperaba >= 45ms, obtuvo ${elapsed}ms`);
    });

    it('devuelve una promesa', () => {
        const result = sleep(1);
        assert.ok(result instanceof Promise);
    });
});
