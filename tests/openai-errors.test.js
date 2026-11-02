import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    OpenAIQuotaError,
    describeOpenAIError,
    isInsufficientQuotaError,
    isRetryableOpenAIError,
    throwIfInsufficientQuota,
    TruncatedOutputError
} from '../openai-errors.js';

describe('openai-errors', () => {
    it('detecta insufficient_quota por codigo directo', () => {
        const err = { status: 429, code: 'insufficient_quota', message: 'quota' };

        assert.equal(isInsufficientQuotaError(err), true);
    });

    it('detecta insufficient_quota por mensaje del SDK', () => {
        const err = {
            status: 429,
            message: '429 You exceeded your current quota, please check your plan and billing details.'
        };

        assert.equal(isInsufficientQuotaError(err), true);
    });

    it('no confunde rate limit temporal con cuota insuficiente', () => {
        const err = {
            status: 429,
            code: 'rate_limit_exceeded',
            message: 'Rate limit reached for requests.'
        };

        assert.equal(isInsufficientQuotaError(err), false);
    });

    it('describe el error usando codigo antes que mensaje', () => {
        const err = {
            error: { code: 'insufficient_quota' },
            message: 'mensaje largo'
        };

        assert.equal(describeOpenAIError(err), 'insufficient_quota');
    });

    it('lanza OpenAIQuotaError con causa original', () => {
        const err = { status: 429, code: 'insufficient_quota' };

        assert.throws(
            () => throwIfInsufficientQuota(err, 'OpenAI pagina 1'),
            error => error instanceof OpenAIQuotaError && error.cause === err
        );
    });
});

describe('isRetryableOpenAIError', () => {
    it('reintenta errores transitorios', () => {
        for (const status of [408, 409, 429, 500, 503]) {
            assert.equal(isRetryableOpenAIError({ status, message: 'transitorio' }), true, String(status));
        }
        assert.equal(isRetryableOpenAIError(new Error('Connection error.')), true);
    });

    it('no reintenta solicitudes invalidas ni cuota agotada', () => {
        for (const status of [400, 401, 403, 404, 413, 422]) {
            assert.equal(isRetryableOpenAIError({ status, message: 'invalida' }), false, String(status));
        }
        assert.equal(isRetryableOpenAIError({ status: 429, code: 'insufficient_quota' }), false);
    });

    it('deja las salidas truncadas al manejo con mas tokens', () => {
        assert.equal(isRetryableOpenAIError(new TruncatedOutputError('truncado')), false);
    });
});
