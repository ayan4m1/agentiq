import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// the real prompt reads the terminal, so it answers whatever the test says to
const confirm = mock.fn<(config: { message: string }) => Promise<boolean>>();

mock.module('@inquirer/prompts', { namedExports: { confirm } });

const { handler } = await import('./ask_boolean');
const { terminal } = await import('../modules/turn');

beforeEach(() => {
  terminal.interactive = true;
  confirm.mock.resetCalls();
});

describe('ask_boolean', () => {
  test('tells the model to decide when nobody can answer', async () => {
    terminal.interactive = false;

    assert.match(
      await handler({ question: 'Shall I go on?' }),
      /running non-interactively/
    );
    assert.equal(confirm.mock.callCount(), 0);
  });

  test('puts the question to the user', async () => {
    confirm.mock.mockImplementationOnce(async () => true);

    await handler({ question: 'Shall I go on?' });

    assert.equal(confirm.mock.calls[0].arguments[0].message, 'Shall I go on?');
  });

  test('reports a yes', async () => {
    confirm.mock.mockImplementationOnce(async () => true);

    assert.equal(
      await handler({ question: 'Shall I go on?' }),
      'The user answered "yes".'
    );
  });

  test('reports a no', async () => {
    confirm.mock.mockImplementationOnce(async () => false);

    assert.equal(
      await handler({ question: 'Shall I go on?' }),
      'The user answered "no".'
    );
  });
});
