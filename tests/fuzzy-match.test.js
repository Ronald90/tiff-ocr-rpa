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
    matchPageWithDocumentsByContext
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
