import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectEsSirefo } from '../extractor.js';

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
