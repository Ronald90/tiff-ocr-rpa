import { it } from 'node:test';
import assert from 'node:assert/strict';
import { limitCompletions } from '../openai-client.js';

it('limita las llamadas simultaneas entre trabajos independientes', async () => {
    let active = 0;
    let peak = 0;
    const create = limitCompletions(async value => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return value;
    }, 2, 10);

    const results = await Promise.all(Array.from({ length: 7 }, (_, index) => create(index)));
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(peak, 2);
    assert.equal(active, 0);
});
