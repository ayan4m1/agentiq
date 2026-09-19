import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { tools } from './index';

describe('tools', () => {
  test('every tool can be called', () => {
    for (const tool of tools) {
      assert.equal(typeof tool.handler, 'function');
    }
  });

  test('every tool is described to the model by name', () => {
    for (const tool of tools) {
      assert.equal(tool.definition.type, 'function');
      assert.ok(tool.definition.function.name);
      assert.ok(tool.definition.function.description);
    }
  });

  test('no two tools share a name', () => {
    // calls are dispatched by name, so a duplicate would shadow the other
    const names = tools.map((tool) => tool.definition.function.name);

    assert.equal(new Set(names).size, names.length);
  });
});
