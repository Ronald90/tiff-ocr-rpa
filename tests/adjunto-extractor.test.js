import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeTipoProcesoValue,
    extractExplicitTipoProcesoFallback
} from '../adjunto-extractor.js';

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
