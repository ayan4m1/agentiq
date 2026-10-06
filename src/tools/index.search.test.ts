import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// config is read when the module first evaluates, so the key has to be set
// before the import below - which is why this is its own file
process.env.AQ_CERAMIC_API_KEY = 'cer-test';

const { tools } = await import('./index');

describe('tools, when a Ceramic API key is set', () => {
  test('include search', () => {
    const names = tools.map((tool) => tool.definition.function.name);

    assert.ok(names.includes('search'));
  });
});
