import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    matchSingleNumber,
    extractDocCode,
    extractRCodes,
    findBestMatchInText,
    matchPageWithDocuments,
    extractDocDateKey,
    extractPageDateKeys,
    extractLooseCodeCandidates,
    matchPageWithDocumentsByContext,
    matchPageWithDocumentsByStamp
} from '../fuzzy-match.js';

// ── extractDocCode ────────────────────────────────────────────────────

describe('extractDocCode', () => {
    it('extrae codigo R-XXXXXX con formato estándar', () => {
        assert.equal(extractDocCode('R-241594 DE 20 DE OCTUBRE DE 2025'), 'R-241594');
    });

    it('extrae codigo R-XXXXXXX de 7 dígitos', () => {
        assert.equal(extractDocCode('R-1234567 algo'), 'R-1234567');
    });

    it('extrae codigo con R seguido de punto', () => {
        assert.equal(extractDocCode('R.266293 algo'), 'R-266293');
    });

    it('extrae codigo aunque la fecha venga pegada al codigo', () => {
        assert.equal(extractDocCode('R-251991DE30DE OCTUBRE DE 2025'), 'R-251991');
    });

    it('normaliza digitos ambiguos en codigo de caratula', () => {
        assert.equal(extractDocCode('R-25I991 DE 30 DE OCTUBRE DE 2025'), 'R-251991');
    });

    it('no arrastra digitos de fecha despues del codigo', () => {
        assert.equal(extractDocCode('R-251991 30 DE OCTUBRE DE 2025'), 'R-251991');
    });

    it('no toma los primeros 7 digitos de un numero R demasiado largo', () => {
        const result = matchSingleNumber('R-1208407162', ['R-1208407 DE 12 DE NOVIEMBRE DE 2025']);
        assert.equal(result.matched, false);
    });

    it('extrae codigo R con digitos separados por espacios', () => {
        assert.equal(extractDocCode('R-26 912 DE 12 DE NOVIEMBRE DE 2025'), 'R-26912');
    });

    it('extrae solo dígitos cuando no hay prefijo R', () => {
        assert.equal(extractDocCode('DOCUMENTO 241594 FECHA'), 'R-241594');
    });

    it('devuelve null para texto sin código', () => {
        assert.equal(extractDocCode('SIN CODIGO AQUI'), null);
    });

    it('devuelve null para null', () => {
        assert.equal(extractDocCode(null), null);
    });

    it('devuelve null para vacío', () => {
        assert.equal(extractDocCode(''), null);
    });

    it('extrae patron genérico LETRA-NÚMERO como fallback', () => {
        const result = extractDocCode('TRAMITE ABC-123');
        assert.equal(result, 'ABC-123');
    });
});

// ── extractRCodes ─────────────────────────────────────────────────────

describe('extractRCodes', () => {
    it('extrae múltiples códigos R-XXXXXX', () => {
        const text = 'Documentos R-263056 y R-264273 procesados';
        const codes = extractRCodes(text);
        assert.deepEqual(codes, ['R-263056', 'R-264273']);
    });

    it('elimina duplicados', () => {
        const text = 'R-263056 y R-263056 repetido';
        const codes = extractRCodes(text);
        assert.deepEqual(codes, ['R-263056']);
    });

    it('devuelve array vacío para texto sin códigos', () => {
        assert.deepEqual(extractRCodes('sin codigos aqui'), []);
    });

    it('devuelve array vacío para null', () => {
        assert.deepEqual(extractRCodes(null), []);
    });

    it('maneja formato R.XXXXXX (punto)', () => {
        const codes = extractRCodes('R.123456');
        assert.deepEqual(codes, ['R-123456']);
    });

    it('maneja formato con espacios', () => {
        const codes = extractRCodes('R 123456');
        assert.deepEqual(codes, ['R-123456']);
    });

    it('maneja formato con espacios internos entre digitos', () => {
        const codes = extractRCodes('Recibido R-26 912 en sello ASFI');
        assert.deepEqual(codes, ['R-26912']);
    });

    it('maneja codigo partido por salto de linea', () => {
        const codes = extractRCodes('Sello ASFI\nR-\n251991\nRecepcion');
        assert.deepEqual(codes, ['R-251991']);
    });

    it('maneja prefijo o digitos confundidos visualmente', () => {
        const codes = extractRCodes('Recibido P-25I991 en sello ASFI');
        assert.deepEqual(codes, ['R-251991']);
    });

    it('no convierte la dirección "pisos 4" en R-15054', () => {
        assert.deepEqual(extractRCodes('Torre A, pisos 4, 5, 6'), []);
        assert.deepEqual(extractLooseCodeCandidates('Torre A, pisos 4, 5, 6'), []);
        assert.deepEqual(extractLooseCodeCandidates('Torre A, pisos 4 5'), []);
        assert.equal(matchSingleNumber('pisos 4', ['R-15054']).matched, false);
        assert.equal(matchPageWithDocumentsByContext('pisos 4', ['R-15054']).matched, false);
    });

    it('no agrega letras de palabras posteriores como digitos', () => {
        const codes = extractRCodes('Recibido R-251991 SEÑOR JUEZ');
        assert.deepEqual(codes, ['R-251991']);
    });
});

// ── findBestMatchInText ───────────────────────────────────────────────

describe('findBestMatchInText', () => {
    it('encuentra coincidencia exacta', () => {
        const result = findBestMatchInText('R-241594', 'DOCUMENTO R-241594 EXPEDIDO');
        assert.equal(result.found, true);
        assert.equal(result.score, 1.0);
    });

    it('no encuentra null/vacío', () => {
        assert.deepEqual(findBestMatchInText(null, 'algo'), { found: false, score: 0 });
        assert.deepEqual(findBestMatchInText('', 'algo'), { found: false, score: 0 });
        assert.deepEqual(findBestMatchInText('algo', null), { found: false, score: 0 });
    });

    it('encuentra coincidencia con errores de transcripcion (1 digito)', () => {
        const result = findBestMatchInText('R241594', 'R241584');
        assert.equal(result.found, true);
        assert.ok(result.score >= 0.7);
    });

    it('no marca match con texto completamente diferente', () => {
        const result = findBestMatchInText('R241594', 'ABCDEFG');
        assert.equal(result.found, false);
    });
});

// ── matchSingleNumber ─────────────────────────────────────────────────

describe('matchSingleNumber', () => {
    const documentList = [
        'R-241594 DE 20 DE OCTUBRE DE 2025',
        'R-266293 DE 15 DE NOVIEMBRE DE 2025',
        'R-123456 DE 5 DE DICIEMBRE DE 2025'
    ];

    it('match exacto con formato R-XXXXXX', () => {
        const result = matchSingleNumber('R-241594', documentList);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-241594');
        assert.equal(result.score, 1);
    });

    it('match con solo dígitos', () => {
        const result = matchSingleNumber('266293', documentList);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-266293');
    });

    it('match con codigo de 5 digitos separado por espacios', () => {
        const result = matchSingleNumber('R-26 912', ['R-26912 DE 12 DE NOVIEMBRE DE 2025']);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-26912');
    });

    it('match con prefijo P- (manuscrito confuso)', () => {
        const result = matchSingleNumber('P-241594', documentList);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-241594');
    });

    it('match con prefijo K-', () => {
        const result = matchSingleNumber('K-266293', documentList);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-266293');
    });

    it('match con digito ambiguo I leído como 1', () => {
        const result = matchSingleNumber('R-25I991', ['R-251991 DE 30 DE OCTUBRE DE 2025']);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-251991');
    });

    it('no match con número inexistente', () => {
        const result = matchSingleNumber('R-999999', documentList);
        assert.equal(result.matched, false);
    });

    it('match con 1 digito de diferencia por error de transcripcion', () => {
        const result = matchSingleNumber('R-241584', documentList);
        // MAX_CODE_DIGIT_DISTANCE = 1, así que 1 dígito de diferencia debería matchear
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-241594');
    });

    it('permite un digito distinto si el candidato es unico aunque otros codigos se parezcan', () => {
        const docs = ['R-241770', 'R-241594', 'R-241595'];
        const result = matchSingleNumber('R-291770', docs);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-241770');
        assert.equal(result.score, 0.8333);
        assert.equal(result.similarCodesDetected, true);
    });

    it('no match con 2 dígitos de diferencia', () => {
        const result = matchSingleNumber('R-241000', documentList);
        assert.equal(result.matched, false);
    });

    it('devuelve no match para null', () => {
        const result = matchSingleNumber(null, documentList);
        assert.equal(result.matched, false);
    });

    it('devuelve no match para lista vacía', () => {
        const result = matchSingleNumber('R-241594', []);
        assert.equal(result.matched, false);
    });

    it('no devuelve match ambiguo entre dos códigos equidistantes', () => {
        const ambiguousList = [
            'R-241594 DE 20 DE OCTUBRE',
            'R-241595 DE 21 DE OCTUBRE'
        ];
        // R-241590 está a distancia 1 de ambos, debería ser ambiguo
        const result = matchSingleNumber('R-241590', ambiguousList);
        // Ambiguous → no matched
        assert.equal(result.matched, false);
    });

    it('match con una cifra faltante permitiendo diferencia de longitud controlada', () => {
        const result = matchSingleNumber('25822', ['R-258122 DE 07 DE NOVIEMBRE DE 2025'], { maxLengthDelta: 1 });
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-258122');
    });

    it('prefiere codigo exacto aunque la caratula tenga fecha pegada y haya codigos similares', () => {
        const docs = [
            'R-251991DE30DE OCTUBRE DE 2025',
            'R-251992 DE 30 DE OCTUBRE DE 2025'
        ];
        const result = matchSingleNumber('R-251991', docs);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-251991');
        assert.equal(result.documento, 'R-251991DE30DE OCTUBRE DE 2025');
    });
});

// ── matchPageWithDocuments ─────────────────────────────────────────────

describe('matchPageWithDocuments', () => {
    const docs = [
        'R-263056 DE 10 DE OCTUBRE DE 2025',
        'R-264273 DE 15 DE OCTUBRE DE 2025'
    ];

    it('encuentra código en texto de página', () => {
        const result = matchPageWithDocuments('Recibido R-263056 en ASFI', docs);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-263056');
    });

    it('no encuentra código en texto sin R-', () => {
        const result = matchPageWithDocuments('Sin codigo relevante', docs);
        assert.equal(result.matched, false);
    });
});

describe('context-aware page matching', () => {
    it('extrae fecha de documento adjunto', () => {
        assert.equal(extractDocDateKey('R-258122 DE 07 DE NOVIEMBRE DE 2025'), '2025-11-07');
    });

    it('extrae fechas visibles desde OCR de pagina', () => {
        const dates = extractPageDateKeys('ASFI\n07 NOV 2025\nLa Paz, 15 de octubre de 2025');
        assert.deepEqual(dates.sort(), ['2025-10-15', '2025-11-07']);
    });

    it('extrae candidatos flexibles desde el sello ASFI', () => {
        const candidates = extractLooseCodeCandidates('ASFI\n07 NOV 2025\n258/22\nLP');
        assert.deepEqual(candidates, ['25822']);
    });

    it('extrae candidatos con digitos ambiguos desde sello ASFI', () => {
        const candidates = extractLooseCodeCandidates('ASFI\nR-25I991\nRECIBIDO');
        assert.deepEqual(candidates, ['251991']);
    });

    it('recupera R-258122 desde OCR con fecha y codigo parcial del sello', () => {
        const pageText = [
            'ASFI',
            '07 NOV 2025',
            '258/22',
            'LP',
            'La Paz, 15 de octubre de 2025.'
        ].join('\n');
        const docs = [
            'R-258122 DE 07 DE NOVIEMBRE DE 2025',
            'R-262479 DE 12 DE NOVIEMBRE DE 2025'
        ];

        const result = matchPageWithDocumentsByContext(pageText, docs);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-258122');
    });
});

describe('matchPageWithDocumentsByStamp', () => {
    const docs = [
        'R-263056 DE 10 DE OCTUBRE DE 2025',
        'R-264273 DE 15 DE OCTUBRE DE 2025',
        'R-15054 DE 20 DE OCTUBRE DE 2025'
    ];

    it('asigna el codigo con prefijo R y devuelve el candidato leido', () => {
        const result = matchPageWithDocumentsByStamp('Oficio 100/2025\nASFI RECEPCION\nR-263056', docs);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-263056');
        assert.equal(result.candidate, 'R-263056');
    });

    it('conserva el candidato aproximado para auditar el match', () => {
        const result = matchPageWithDocumentsByStamp('Sello ASFI R-263057', docs);
        assert.equal(result.matched, true);
        assert.equal(result.code, 'R-263056');
        assert.equal(result.candidate, 'R-263057');
    });

    it('acepta digitos sueltos del sello solo si coinciden exactamente', () => {
        assert.equal(matchPageWithDocumentsByStamp('ASFI\n07 NOV 2025\n15054', docs).code, 'R-15054');
        assert.equal(matchPageWithDocumentsByStamp('ASFI\n07 NOV 2025\n15014', docs).matched, false);
    });

    it('ignora numeros sueltos del cuerpo como CI o montos', () => {
        const result = matchPageWithDocumentsByStamp('Demandado: Persona de Prueba\nC.I. 263056\nMonto 264273', docs);
        assert.equal(result.matched, false);
    });

    it('no decide si la pagina cita varios codigos de la lista', () => {
        const result = matchPageWithDocumentsByStamp('Adjuntos: R-263056 y R-264273', docs);
        assert.equal(result.matched, false);
    });
});
