import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// the real exploration runs a whole conversation against the model, so it
// answers whatever the test says to
const explore = mock.fn<(question: string) => Promise<string>>();

mock.module('../modules/explore', { exports: { explore } });

const { definition, handler } = await import('./explore');

beforeEach(() => {
  explore.mock.resetCalls();
  explore.mock.mockImplementation(async () => '');
});

describe('explore', () => {
  test('is declared as the explore tool', () => {
    assert.equal(definition.type, 'function');
    assert.equal(definition.function.name, 'explore');
    assert.ok(definition.function.description);
  });

  test('requires a question', () => {
    const { parameters } = definition.function;

    assert.deepEqual(parameters?.required, ['question']);
    assert.equal(parameters?.properties?.question?.type, 'string');
  });

  test('hands the question to the exploration', async () => {
    await handler({ question: 'Where is the approval mode enforced?' });

    assert.equal(explore.mock.callCount(), 1);
    assert.deepEqual(explore.mock.calls[0].arguments, [
      'Where is the approval mode enforced?'
    ]);
  });

  test('returns the report unchanged', async () => {
    explore.mock.mockImplementationOnce(
      async () => 'src/modules/shell.ts:10-20 checks the approval mode'
    );

    assert.equal(
      await handler({ question: 'Where is the approval mode enforced?' }),
      'src/modules/shell.ts:10-20 checks the approval mode'
    );
  });

  test('passes a failed exploration on to the caller', async () => {
    explore.mock.mockImplementationOnce(async () => {
      throw new Error('model went away');
    });

    await assert.rejects(
      handler({ question: 'Where is the approval mode enforced?' }),
      /model went away/
    );
  });
});
