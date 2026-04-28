import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    OpenAIQuotaError,
    describeOpenAIError,
    isInsufficientQuotaError,
    throwIfInsufficientQuota
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
