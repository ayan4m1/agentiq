import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// the real prompt reads the terminal, so it answers whatever the test says to
const select =
  mock.fn<
    (config: { message: string; choices: string[] }) => Promise<string>
  >();

mock.module('@inquirer/prompts', { namedExports: { select } });

const { handler } = await import('./ask_list');
const { terminal } = await import('../modules/interactive');

beforeEach(() => {
  terminal.interactive = true;
  select.mock.resetCalls();
});

describe('ask_list', () => {
  test('tells the model to decide when nobody can answer', async () => {
    terminal.interactive = false;

    assert.match(
      await handler({ question: 'Which color?', choices: ['red', 'blue'] }),
      /running non-interactively/
    );
    assert.equal(select.mock.callCount(), 0);
  });

  test('offers the choices along with the question', async () => {
    select.mock.mockImplementationOnce(async () => 'red');

    await handler({ question: 'Which color?', choices: ['red', 'blue'] });

    assert.deepEqual(select.mock.calls[0].arguments[0], {
      message: 'Which color?',
      choices: ['red', 'blue']
    });
  });

  test('reports the choice that was made', async () => {
    select.mock.mockImplementationOnce(async () => 'blue');

    assert.equal(
      await handler({ question: 'Which color?', choices: ['red', 'blue'] }),
      'The user selected "blue"'
    );
  });
});
