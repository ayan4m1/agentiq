import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { ApprovalAnswer, ApprovalMode } from '../types';

// remembered answers are written under the home directory, which is read as
// the config module is evaluated - so it has to point somewhere disposable
// before anything below is imported
process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-approval-'));

// the approval prompt is built on @inquirer/core and reads the real terminal,
// so it is replaced by one that answers whatever the test says to
const answer = mock.fn<(config: { message: string }) => Promise<string>>();
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

const {
  approval,
  cycleMode,
  describeDenial,
  describeMode,
  refusePlanning,
  requestApproval,
  setMode
} = await import('./approval');
const { isRemembered, remember } = await import('./rules');
const { takeYield } = await import('./turn');

// a mode change announces itself, which is only noise here
const log = mock.method(console, 'log', () => {});

const answerWith = (value: string) =>
  answer.mock.mockImplementationOnce(async () => value);

beforeEach(() => {
  approval.mode = ApprovalMode.Manual;
  answer.mock.resetCalls();
  input.mock.resetCalls();
  log.mock.resetCalls();
  takeYield();
});

describe('modes', () => {
  test('cycles from manual to auto to plan and back', () => {
    assert.equal(cycleMode(), ApprovalMode.Auto);
    assert.equal(cycleMode(), ApprovalMode.Plan);
    assert.equal(cycleMode(), ApprovalMode.Manual);
  });

  test('announces a change of mode', () => {
    setMode(ApprovalMode.Auto);

    assert.equal(approval.mode, ApprovalMode.Auto);
    assert.match(
      String(log.mock.calls[0].arguments[0]),
      /changes apply without asking/
    );
  });

  test('describes the mode it is in', () => {
    assert.match(describeMode(), /manual/);

    approval.mode = ApprovalMode.Plan;

    assert.match(describeMode(), /plan/);
  });
});

describe('describeDenial', () => {
  test('says what was declined', () => {
    assert.equal(
      describeDenial('write to a.txt'),
      'The user declined to write to a.txt.'
    );
  });

  test('passes on the reason the user gave', () => {
    assert.equal(
      describeDenial('write to a.txt', 'wrong file'),
      'The user declined to write to a.txt. They said: "wrong file"'
    );
  });
});

describe('refusePlanning', () => {
  test('lets everything through outside plan mode', () => {
    assert.equal(refusePlanning('no files can be written'), undefined);
  });

  test('refuses in plan mode and points at present_plan', () => {
    approval.mode = ApprovalMode.Plan;

    assert.equal(
      refusePlanning('no files can be written'),
      'Plan mode is active, so no files can be written. Use the present_plan tool to propose an approach and ask to start work.'
    );
  });
});

describe('requestApproval', () => {
  test('approves without asking in auto mode', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.deepEqual(await requestApproval('OK?'), { approved: true });
    assert.equal(answer.mock.callCount(), 0);
  });

  test('asks with the message it was given', async () => {
    answerWith(ApprovalAnswer.Once);

    await requestApproval('OK to run "ls"?');

    assert.equal(answer.mock.calls[0].arguments[0].message, 'OK to run "ls"?');
  });

  test('approves once without remembering the answer', async () => {
    answerWith(ApprovalAnswer.Once);

    const subject = { kind: 'command', value: 'yarn once' } as const;

    assert.deepEqual(await requestApproval('OK?', subject), {
      approved: true
    });
    assert.equal(isRemembered('command', 'yarn once'), false);
  });

  test('remembers an answer of always', async () => {
    answerWith(ApprovalAnswer.Always);

    const subject = { kind: 'command', value: 'yarn always' } as const;

    assert.deepEqual(await requestApproval('OK?', subject), {
      approved: true
    });
    assert.equal(isRemembered('command', 'yarn always'), true);
  });

  test('does not ask again about something remembered', async () => {
    remember('command', 'yarn remembered');

    const result = await requestApproval('OK?', {
      kind: 'command',
      value: 'yarn remembered'
    });

    assert.deepEqual(result, { approved: true });
    assert.equal(answer.mock.callCount(), 0);
  });

  test('hands the keyboard back when told to stop', async () => {
    answerWith(ApprovalAnswer.Stop);

    assert.deepEqual(await requestApproval('OK?'), {
      approved: false,
      stopped: true
    });
    assert.equal(takeYield(), true);
    // stopping is not a refusal the model needs a reason for
    assert.equal(input.mock.callCount(), 0);
  });

  test('asks why after a refusal', async () => {
    answerWith(ApprovalAnswer.No);
    input.mock.mockImplementationOnce(async () => '  wrong directory  ');

    assert.deepEqual(await requestApproval('OK?'), {
      approved: false,
      reason: 'wrong directory'
    });
  });

  test('leaves the reason out when none was given', async () => {
    answerWith(ApprovalAnswer.No);
    input.mock.mockImplementationOnce(async () => '');

    assert.deepEqual(await requestApproval('OK?'), {
      approved: false,
      reason: undefined
    });
  });
});
