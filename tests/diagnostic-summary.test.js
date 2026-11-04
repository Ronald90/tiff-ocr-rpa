import { it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnosticAdjunto } from '../diagnostic-summary.js';

it('resume por codigo los campos recuperados y pendientes sin exponer sus valores', () => {
    const lines = formatDiagnosticAdjunto({
        id_buscado: 'R-12345',
        pagina: 31,
        nro_cite: 'CITE 100/2025',
        demandante: 'Nombre Privado',
        demandados: [{ nombre: 'Otra Persona', nro_documento: '1234567' }],
        juez: '',
        _error: 'Fragmento 2 sin cache'
    });

    assert.match(lines[0], /R-12345 \(pagina 31\) - extraccion pendiente; 1 demandado\(s\)/);
    assert.match(lines[1], /Con dato: nro_cite, demandante, demandados/);
    assert.match(lines[2], /Sin dato \(puede no aplicar\): .*juez/);
    assert.doesNotMatch(lines.join('\n'), /Nombre Privado|Otra Persona|1234567|CITE 100\/2025/);
});
