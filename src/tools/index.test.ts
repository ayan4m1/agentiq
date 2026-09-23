import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// empty rather than deleted, so a value in a local .env cannot fill it back in
process.env.AQ_ENABLE_ROADMAP = '';

const { tools } = await import('./index');

const roadmapToolNames = [
  'add_todo',
  'complete_todo',
  'remove_todo',
  'update_notes'
];

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

  test('leaves out the roadmap tools unless AQ_ENABLE_ROADMAP is set', () => {
    const names = tools.map((tool) => tool.definition.function.name);

    for (const name of roadmapToolNames) {
      assert.ok(!names.includes(name), `${name} should not be offered`);
    }
  });

  test('does not point the model at a roadmap tool it cannot call', () => {
    for (const tool of tools) {
      assert.doesNotMatch(tool.definition.function.description, /add_todo/);
    }
  });
});
