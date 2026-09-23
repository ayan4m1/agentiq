import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// config is read when the module first evaluates, so the roadmap has to be
// switched on before the import below - which is why this is its own file
process.env.AQ_ENABLE_ROADMAP = 'true';

const { tools } = await import('./index');

describe('tools, when AQ_ENABLE_ROADMAP is set', () => {
  test('include every roadmap tool', () => {
    const names = tools.map((tool) => tool.definition.function.name);

    for (const name of [
      'add_todo',
      'complete_todo',
      'remove_todo',
      'update_notes'
    ]) {
      assert.ok(names.includes(name), `${name} should be offered`);
    }
  });

  test('tell the model to record lasting objectives from a plan', () => {
    const plan = tools.find(
      (tool) => tool.definition.function.name === 'present_plan'
    );

    assert.match(plan!.definition.function.description ?? '', /add_todo/);
  });
});
