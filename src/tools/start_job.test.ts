import { test, describe, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { ApprovalAnswer, ApprovalMode } from '../types';
import { fakeInquirerCore, fakePrompts } from '../../test/fakes/inquirer';

process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-background-'));

const { answer, exports: core } = fakeInquirerCore();
const { input, exports: prompts } = fakePrompts({
  input: mock.fn<() => Promise<string>>()
});

mock.module('@inquirer/core', { exports: core });
mock.module('@inquirer/prompts', { exports: prompts });

const { handler } = await import('./start_job');
const { approval } = await import('../modules/approval');
const { killAllJobs, listJobs } = await import('../modules/jobs');

const command = 'node -e "setInterval(() => {}, 1000)"';
const cwd = process.cwd();

afterEach(() => {
  approval.mode = ApprovalMode.Manual;
});

after(() => {
  killAllJobs();
});

describe('start_job', () => {
  test('refuses to start anything in plan mode', async () => {
    approval.mode = ApprovalMode.Plan;

    assert.match(
      await handler({ command, cwd }),
      /^Plan mode is active, so no commands can be run/
    );
    assert.equal(listJobs(), 'No background jobs have been started.');
  });

  test('starts nothing when declined', async () => {
    answer.mock.mockImplementationOnce(async () => ApprovalAnswer.No);
    input.mock.mockImplementationOnce(async () => '');

    assert.equal(
      await handler({ command, cwd }),
      `The user declined to run "${command}".`
    );
    assert.equal(listJobs(), 'No background jobs have been started.');
  });

  test('asks about the command it is going to run', async () => {
    answer.mock.mockImplementationOnce(async () => ApprovalAnswer.Once);

    await handler({ command, cwd });

    assert.equal(
      answer.mock.calls.at(-1)?.arguments[0].message,
      `OK to run "${command}" in the background?`
    );
  });

  test('starts the job and says how to read it', async () => {
    approval.mode = ApprovalMode.Auto;

    const output = await handler({ command, cwd });
    const id = Number(/^Started job (\d+)\./.exec(output)?.[1]);

    assert.equal(
      output,
      `Started job ${id}. Call read_job with id ${id} to see what it prints.`
    );
    assert.match(listJobs(), new RegExp(`${id} \\[running`));
  });
});
