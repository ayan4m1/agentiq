import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// the real prompt reads the terminal, so it answers whatever the test says to
const select =
  mock.fn<
    (config: { message: string; choices: string[] }) => Promise<string>
  >();

mock.module('@inquirer/prompts', { namedExports: { select } });

const { handler } = await import('./ask_list');

describe('ask_list', () => {
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
