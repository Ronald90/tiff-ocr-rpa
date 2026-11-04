import { ADJUNTO_FIELD_NAMES } from './adjunto-extractor.js';

function hasValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== undefined && value !== null && value !== false;
}

/** Resume un adjunto sin imprimir sus valores ni confundir un campo vacío con un error. */
export function formatDiagnosticAdjunto(adjunto) {
    const conDato = ADJUNTO_FIELD_NAMES.filter(field => hasValue(adjunto[field]));
    const sinDato = ADJUNTO_FIELD_NAMES.filter(field => !hasValue(adjunto[field]));
    const status = adjunto._error ? 'extraccion pendiente'
        : adjunto._revision ? 'revision pendiente' : 'datos recuperados';
    const demandados = Array.isArray(adjunto.demandados) ? adjunto.demandados.length : 0;

    return [
        `  ${adjunto.id_buscado || 'SIN_CODIGO'} (pagina ${adjunto.pagina || '?'}) - ${status}; ${demandados} demandado(s)`,
        `    Con dato: ${conDato.join(', ') || 'ninguno'}`,
        `    Sin dato (puede no aplicar): ${sinDato.join(', ') || 'ninguno'}`
    ];
}
