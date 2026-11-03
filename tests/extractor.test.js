import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import openai from '../openai-client.js';
import { detectEsSirefo, extractFields } from '../extractor.js';

const originalCreate = openai.chat.completions.create;
afterEach(() => { openai.chat.completions.create = originalCreate; });

describe('extractFields', () => {
    it('envia la caratula completa aunque supere 24000 caracteres', async () => {
        const cover = `INICIO_CARATULA\n${'Texto de caratula.\n'.repeat(1500)}FINAL_CARATULA`;
        let sent = '';
        openai.chat.completions.create = async request => {
            sent = request.messages[1].content;
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ documento: 'CARTA CIRCULAR' }) } }] };
        };

        const data = await extractFields(cover);

        assert.ok(cover.length > 24000);
        assert.ok(sent.includes('INICIO_CARATULA'));
        assert.ok(sent.includes('FINAL_CARATULA'));
        assert.equal(data.documento, 'CARTA CIRCULAR');
        assert.equal(data._error, undefined);
    });
});

describe('detectEsSirefo', () => {
    it('devuelve false para menciones normativas genericas sin SIREFO explicito', () => {
        const text = [
            'REF: TRAMITE N° T-1201404792',
            'ORDEN(ES) JUDICIAL(ES)',
            'Los resultados de su cumplimiento, deberan hacer conocer directamente a la(s) Autoridad(es) Competente(s);',
            'asimismo, corresponde aclarar que en el marco de lo dispuesto en el Articulo 473 de la Ley N° 393',
            'y conforme lo establecido en el Reglamento para la Retencion, Suspension de Retencion y Remision de Fondos.',
            'Remision de Fondos, contenido en el Capitulo VI, Titulo II, Libro 2° de la Recopilacion de Normas para Servicios Financieros.'
        ].join('\n');

        assert.equal(detectEsSirefo(text), false);
    });

    it('devuelve true cuando aparece el acronimo SIREFO', () => {
        const text = [
            'Para conocimiento y cumplimiento de las Entidades de Intermediacion Financiera',
            'se adjunta el detalle de las instrucciones remitidas por la Aduana Nacional (AN),',
            'las cuales fueron transmitidas mediante el Sistema de Administracion de Ordenes de Retencion,',
            'Suspension de Retencion y Remision de Fondos (SIREFO).'
        ].join('\n');

        assert.equal(detectEsSirefo(text), true);
    });

    it('devuelve true cuando aparece el nombre completo del sistema aunque no se lea el acronimo', () => {
        const text = 'Las instrucciones fueron remitidas mediante el Sistema de Transmision de Ordenes de Retencion, Suspension de Retencion y Remision de Fondos.';
        assert.equal(detectEsSirefo(text), true);
    });
});
