const INSUFFICIENT_QUOTA_CODES = new Set([
    'insufficient_quota',
    'billing_hard_limit_reached',
    'quota_exceeded'
]);

export class OpenAIQuotaError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'OpenAIQuotaError';
        this.code = 'insufficient_quota';
        this.status = cause?.status || cause?.response?.status || 429;
        this.cause = cause;
    }
}

function firstString(...values) {
    return values.find(value => typeof value === 'string' && value.trim().length > 0) || '';
}

export function getOpenAIErrorCode(err) {
    return firstString(
        err?.code,
        err?.error?.code,
        err?.body?.error?.code,
        err?.response?.data?.error?.code,
        err?.cause?.code
    );
}

export function getOpenAIErrorType(err) {
    return firstString(
        err?.type,
        err?.error?.type,
        err?.body?.error?.type,
        err?.response?.data?.error?.type
    );
}

export function describeOpenAIError(err) {
    return firstString(
        getOpenAIErrorCode(err),
        getOpenAIErrorType(err),
        err?.message,
        err?.error?.message,
        err?.body?.error?.message,
        err?.response?.data?.error?.message,
        'error_desconocido'
    );
}

export function isInsufficientQuotaError(err) {
    if (err instanceof OpenAIQuotaError) return true;

    const fields = [
        getOpenAIErrorCode(err),
        getOpenAIErrorType(err),
        err?.message,
        err?.error?.message,
        err?.body?.error?.message,
        err?.response?.data?.error?.message
    ]
        .filter(value => typeof value === 'string')
        .map(value => value.toLowerCase());

    return fields.some(value => INSUFFICIENT_QUOTA_CODES.has(value)) ||
        fields.some(value =>
            value.includes('insufficient_quota') ||
            value.includes('exceeded your current quota') ||
            value.includes('billing hard limit')
        );
}

export function toOpenAIQuotaError(err, context = 'OpenAI') {
    if (err instanceof OpenAIQuotaError) return err;

    const detail = describeOpenAIError(err);
    const prefix = context ? `${context}: ` : '';
    return new OpenAIQuotaError(
        `${prefix}cuota insuficiente de OpenAI (${detail}). Revisa billing/creditos, limites del proyecto u organizacion y la API key configurada.`,
        err
    );
}

export function throwIfInsufficientQuota(err, context) {
    if (isInsufficientQuotaError(err)) {
        throw toOpenAIQuotaError(err, context);
    }
}
