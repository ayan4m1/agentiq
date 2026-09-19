import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { ApprovalAnswer, ApprovalMode } from '../types';

process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-shell-'));

// the approval prompt reads the terminal, so it answers whatever the test says
const answer = mock.fn<() => Promise<string>>();
const input = mock.fn<() => Promise<string>>();

mock.module('@inquirer/core', {
  namedExports: {
    createPrompt: () => answer,
    isEnterKey: () => false,
    useKeypress: () => {},
    useState: (value: unknown) => [value, () => {}]
  }
});
mock.module('@inquirer/prompts', { namedExports: { input } });

const { handler } = await import('./shell');
const { approval } = await import('../modules/approval');
const { shell } = await import('../modules/config');

const cwd = process.cwd();
const timeout = shell.timeout;

// the command's output is echoed as it arrives. it is left to print: swapping
// out process.stdout.write also swallows the test runner's own reports
const run = (command: string, where = cwd) => handler({ command, cwd: where });

afterEach(() => {
  approval.mode = ApprovalMode.Manual;
  shell.timeout = timeout;
});

describe('shell', () => {
  test('refuses to run anything in plan mode', async () => {
    approval.mode = ApprovalMode.Plan;

    assert.match(
      await run('node -e "1"'),
      /^Plan mode is active, so no commands can be run/
    );
  });

  test('passes on the reason a command was declined', async () => {
    answer.mock.mockImplementationOnce(async () => ApprovalAnswer.No);
    input.mock.mockImplementationOnce(async () => 'not now');

    assert.equal(
      await run('node -e "1"'),
      'The user declined to run "node -e "1"". They said: "not now"'
    );
  });

  test('returns what the command printed', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.equal(await run(`node -e "console.log('hello')"`), 'hello');
  });

  test('includes what was printed to stderr', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.equal(await run(`node -e "console.error('oops')"`), 'oops');
  });

  test('says so when there was no output', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.equal(await run('node -e "1"'), 'The command produced no output.');
  });

  test('reports a failing exit code along with the output', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.equal(
      await run(`node -e "console.log('partial'); process.exit(3)"`),
      'The command exited with code 3.\n\nOutput:\npartial'
    );
  });

  test('kills a command that runs past the timeout', async () => {
    approval.mode = ApprovalMode.Auto;
    shell.timeout = 500;

    assert.match(
      await run(
        `node -e "console.log('started'); setInterval(() => {}, 1000)"`
      ),
      /^The command timed out after 500ms and was killed\.\n\nOutput so far:\nstarted$/
    );
  });

  test('reports a command that could not be started', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.match(
      await run('node -e "1"', resolve(cwd, 'no-such-directory')),
      /^The command could not be started: /
    );
  });
});
