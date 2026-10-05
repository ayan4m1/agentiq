import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// config is read when the module first evaluates, so exploration has to be
// switched off before the import below - which is why this is its own file
process.env.AQ_EXPLORE = 'false';

const { tools } = await import('./index');

describe('tools, when AQ_EXPLORE is off', () => {
  test('leave out explore', () => {
    const names = tools.map((tool) => tool.definition.function.name);

    assert.ok(!names.includes('explore'));
  });
});
