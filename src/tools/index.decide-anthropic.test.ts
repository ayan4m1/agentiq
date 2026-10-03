import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// config is read when the module first evaluates, so the provider and the
// decision model have to be set before the import below - which is why this is
// its own file
process.env.AQ_PROVIDER = 'anthropic';
process.env.AQ_DECIDE_MODEL = 'kev-9b';

const { tools } = await import('./index');

describe('tools, when anthropic is the provider', () => {
  test('leave out decide even with a decision model set', () => {
    const names = tools.map((tool) => tool.definition.function.name);

    assert.ok(!names.includes('decide'));
  });
});
