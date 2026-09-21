import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { ApprovalAnswer, ApprovalMode } from '../types';

// remembered answers are written under the home directory, which is read as
// the config module is evaluated - so it has to point somewhere disposable
// before anything below is imported
const home = mkdtempSync(resolve(tmpdir(), 'agentiq-approval-'));

process.env.AQ_HOME = home;

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
  isRemembered,
  loadRules,
  matchesRule,
  normalizePath,
  refusePlanning,
  remember,
  requestApproval,
  setMode
} = await import('./approval');
const { slugFor } = await import('../utils');
const { takeYield, terminal } = await import('./turn');

// a mode change announces itself, which is only noise here
const log = mock.method(console, 'log', () => {});

const answerWith = (value: string) =>
  answer.mock.mockImplementationOnce(async () => value);

beforeEach(() => {
  approval.mode = ApprovalMode.Manual;
  terminal.interactive = true;
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

describe('requestApproval without a terminal', () => {
  beforeEach(() => {
    terminal.interactive = false;
  });

  test('refuses without asking, and says why', async () => {
    const result = await requestApproval('OK?', {
      kind: 'command',
      value: 'yarn unattended'
    });

    assert.equal(result.approved, false);
    assert.match(result.reason ?? '', /running non-interactively/);
    assert.equal(answer.mock.callCount(), 0);
    assert.equal(input.mock.callCount(), 0);
  });

  test('still allows something remembered', async () => {
    remember('command', 'yarn unattended remembered');

    assert.deepEqual(
      await requestApproval('OK?', {
        kind: 'command',
        value: 'yarn unattended remembered'
      }),
      { approved: true }
    );
    assert.equal(answer.mock.callCount(), 0);
  });

  test('still approves everything in auto mode', async () => {
    approval.mode = ApprovalMode.Auto;

    assert.deepEqual(await requestApproval('OK?'), { approved: true });
    assert.equal(answer.mock.callCount(), 0);
  });
});

describe('rules', () => {
  const projectA = resolve(home, 'project-a');
  const projectB = resolve(home, 'project-b');
  const original = process.cwd();

  const rulesFor = (cwd: string) =>
    resolve(home, 'approvals', `${slugFor(cwd)}.json`);

  before(() => {
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    process.chdir(projectA);
  });

  beforeEach(() => {
    rmSync(rulesFor(projectA), { force: true });
    rmSync(rulesFor(projectB), { force: true });
    process.chdir(projectA);
  });

  after(() => {
    process.chdir(original);
  });

  describe('matchesRule', () => {
    test('matches an exact value', () => {
      assert.ok(matchesRule('yarn test', 'yarn test'));
    });

    test('does not match a different value', () => {
      assert.ok(!matchesRule('yarn test', 'yarn build'));
    });

    test('does not treat an exact rule as a prefix', () => {
      // approving "git status" must not also approve "git status && rm -rf ."
      assert.ok(!matchesRule('git status', 'git status && something else'));
    });

    test('a single star stays inside one segment', () => {
      assert.ok(matchesRule('src/*.ts', 'src/index.ts'));
      assert.ok(!matchesRule('src/*.ts', 'src/modules/index.ts'));
    });

    test('a double star spans segments', () => {
      assert.ok(matchesRule('src/**', 'src/modules/deep/file.ts'));
    });

    test('treats a dot as a literal rather than any character', () => {
      assert.ok(!matchesRule('a.ts', 'axts'));
    });

    test('survives a pattern that will not compile', () => {
      assert.equal(matchesRule('[', 'anything'), false);
    });
  });

  describe('normalizePath', () => {
    test('keeps a path inside the project relative to it', () => {
      assert.equal(normalizePath('src/index.ts'), 'src/index.ts');
    });

    test('reduces an absolute path inside the project to a relative one', () => {
      // so the rules still mean something after the directory moves
      assert.equal(normalizePath(resolve(projectA, 'src/a.ts')), 'src/a.ts');
    });

    test('leaves a path outside the project absolute', () => {
      assert.ok(normalizePath(resolve(projectB, 'x.ts')).includes('project-b'));
    });

    test('answers in forward slashes whatever the platform', () => {
      assert.ok(!normalizePath('src/deep/a.ts').includes('\\'));
    });
  });

  describe('remembering an answer', () => {
    test('is not remembered until it is asked for', () => {
      assert.equal(isRemembered('command', 'yarn test'), false);
    });

    test('holds for the same command afterwards', () => {
      remember('command', 'yarn test');

      assert.ok(isRemembered('command', 'yarn test'));
    });

    test('does not spill onto a different command', () => {
      remember('command', 'yarn test');

      assert.equal(isRemembered('command', 'yarn build'), false);
    });

    test('holds for a path however it was spelled', () => {
      remember('path', 'src/index.ts');

      assert.ok(isRemembered('path', resolve(projectA, 'src', 'index.ts')));
    });

    test('keeps commands and paths apart', () => {
      remember('command', 'src/index.ts');

      assert.equal(isRemembered('path', 'src/index.ts'), false);
    });

    test('writes the answer down only once', () => {
      remember('command', 'yarn test');
      remember('command', 'yarn test');

      assert.deepEqual(loadRules().command, ['yarn test']);
    });

    test('says nothing about another project', () => {
      remember('command', 'yarn test');
      process.chdir(projectB);

      // an answer given about one project is not an answer about another
      assert.equal(isRemembered('command', 'yarn test'), false);
    });

    test('honours a pattern written into the file by hand', () => {
      mkdirSync(resolve(home, 'approvals'), { recursive: true });
      writeFileSync(
        rulesFor(projectA),
        JSON.stringify({ command: [], path: ['src/**'] })
      );

      assert.ok(isRemembered('path', 'src/modules/deep.ts'));
      assert.equal(isRemembered('path', 'other/deep.ts'), false);
    });

    test('survives a rules file that will not parse', () => {
      mkdirSync(resolve(home, 'approvals'), { recursive: true });
      writeFileSync(rulesFor(projectA), 'not json at all');

      assert.deepEqual(loadRules(), { command: [], path: [] });
      assert.equal(isRemembered('command', 'anything'), false);
    });

    test('survives a rules file holding the wrong shape', () => {
      mkdirSync(resolve(home, 'approvals'), { recursive: true });
      writeFileSync(rulesFor(projectA), JSON.stringify({ command: 'nope' }));

      assert.deepEqual(loadRules().command, []);
    });
  });
});
