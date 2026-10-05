import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { ApprovalAnswer, ApprovalMode } from '../types';
import {
  fakeInquirerCore,
  fakePrompts,
  queue
} from '../../test/fakes/inquirer';
import { fakeInterrupt } from '../../test/fakes/interrupt';

process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-shell-'));

const { answer, exports: core } = fakeInquirerCore();
const {
  editor,
  input,
  exports: prompts
} = fakePrompts({
  editor: mock.fn<(config: Record<string, unknown>) => Promise<string>>(),
  input: mock.fn<() => Promise<string>>()
});

mock.module('@inquirer/core', { exports: core });
mock.module('@inquirer/prompts', { exports: prompts });

const interrupt = fakeInterrupt();

mock.module('../modules/interrupt', { exports: interrupt.exports });

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
  interrupt.reset();
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

  test('stops a command when escape is pressed', async () => {
    approval.mode = ApprovalMode.Auto;

    const pending = run(
      `node -e "console.log('started'); setInterval(() => {}, 1000)"`
    );

    // escape only means something once the command is being watched
    while (!interrupt.watchForInterrupt.mock.callCount()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    interrupt.pressEscape();

    assert.match(
      await pending,
      /^The user interrupted the command after \d+ms\./
    );
  });

  test('ends output that did not finish its line', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.equal(await run(`node -e "process.stdout.write('x')"`), 'x');
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

  test('runs the command as the user edited it', async () => {
    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    // the editor's own final newline is not part of the command
    queue(editor, ['node -e "console.log(\'edited\')"\n']);

    const result = await run('node -e "console.log(\'proposed\')"');

    assert.ok(result.endsWith('\n\nedited'));
  });

  test('tells the model the command was changed', async () => {
    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    queue(editor, ['node -e "console.log(2)"']);

    assert.equal(
      await run('node -e "console.log(1)"'),
      'The user changed the command to "node -e "console.log(2)"" before running it.\n\n2'
    );
  });

  test('asks about the edited command before running it', async () => {
    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    queue(editor, ['node -e "2"']);

    await run('node -e "1"');

    assert.equal(
      answer.mock.calls.at(-1)?.arguments[0].message,
      'OK to run command "node -e "2""?'
    );
  });
});
