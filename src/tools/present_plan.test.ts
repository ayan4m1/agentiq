import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { ApprovalMode } from '../types';

// the real prompt reads the terminal, so it answers whatever the test says to
const select =
  mock.fn<(config: { message: string; default?: string }) => Promise<string>>();

mock.module('@inquirer/prompts', {
  namedExports: { select, input: mock.fn() }
});

// the plan path is resolved from the working directory when the module loads,
// so the tool has to be imported from inside a scratch project
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-present-plan-'));
const original = process.cwd();

process.chdir(root);

const { handler } = await import('./present_plan');
const { approval } = await import('../modules/approval');
const { takeYield, terminal } = await import('../modules/turn');
const { planPath } = await import('../modules/plan');

process.chdir(original);

const saved = () => readFileSync(planPath).toString();

// the plan is printed, and so is the change of mode that follows it
const log = mock.method(console, 'log', () => {});
const printed = () =>
  log.mock.calls
    // strip ANSI colors
    .map((call) => String(call.arguments[0].replaceAll(/\x1B\[[0-9;]*m/g, '')))
    .join('\n');

const plan = {
  title: 'Add a test for every source file',
  steps: ['Write the tests', 'Run them']
};

beforeEach(() => {
  approval.mode = ApprovalMode.Plan;
  terminal.interactive = true;
  select.mock.resetCalls();
  log.mock.resetCalls();
  takeYield();
  rmSync(planPath, { force: true });
});

describe('present_plan', () => {
  test('shows the plan before asking', async () => {
    select.mock.mockImplementationOnce(async () => 'keep');

    await handler(plan);

    assert.match(printed(), /Add a test for every source file/);
    assert.match(printed(), /1\.\s+Write the tests/);
    assert.match(printed(), /2\.\s+Run them/);
  });

  test('suggests asking before each change', async () => {
    select.mock.mockImplementationOnce(async () => 'keep');

    await handler(plan);

    assert.equal(select.mock.calls.at(-1)?.arguments[0].default, 'manual');
  });

  test('switches to auto approval when told to go ahead unasked', async () => {
    select.mock.mockImplementationOnce(async () => 'auto');

    assert.match(await handler(plan), /approved the plan and turned on auto/);
    assert.equal(approval.mode, ApprovalMode.Auto);
    assert.equal(takeYield(), false);
  });

  test('switches to manual approval when told to go ahead and ask', async () => {
    select.mock.mockImplementationOnce(async () => 'manual');

    assert.match(await handler(plan), /confirm every change/);
    assert.equal(approval.mode, ApprovalMode.Manual);
    assert.equal(takeYield(), false);
  });

  test('stays in plan mode and hands the keyboard back when declined', async () => {
    select.mock.mockImplementationOnce(async () => 'keep');

    assert.equal(
      await handler(plan),
      'The user declined the plan and has not approved any work.'
    );
    assert.equal(approval.mode, ApprovalMode.Plan);
    assert.equal(takeYield(), true);
  });

  test('saves the plan to PLAN.md once approved', async () => {
    select.mock.mockImplementationOnce(async () => 'manual');

    assert.match(await handler(plan), /read_plan/);
    assert.equal(
      saved(),
      '# Add a test for every source file\n\n1. Write the tests\n2. Run them\n'
    );
  });

  test('saves the plan even when it is declined', async () => {
    select.mock.mockImplementationOnce(async () => 'keep');

    await handler(plan);

    assert.match(saved(), /# Add a test for every source file/);
  });

  test('replaces an earlier plan', async () => {
    select.mock.mockImplementationOnce(async () => 'keep');
    select.mock.mockImplementationOnce(async () => 'keep');

    await handler(plan);
    await handler({ title: 'A better plan', steps: ['Do it'] });

    assert.equal(saved(), '# A better plan\n\n1. Do it\n');
  });
});

describe('present_plan without a terminal', () => {
  beforeEach(() => {
    terminal.interactive = false;
  });

  test('still shows the plan', async () => {
    await handler(plan);

    assert.match(printed(), /Add a test for every source file/);
    assert.equal(select.mock.callCount(), 0);
  });

  test('still saves the plan', async () => {
    await handler(plan);

    assert.match(saved(), /1\. Write the tests/);
  });

  test('ends the run in plan mode, having done nothing', async () => {
    assert.match(await handler(plan), /cannot be approved. No work was done/);
    assert.equal(approval.mode, ApprovalMode.Plan);
    assert.equal(takeYield(), true);
  });

  for (const mode of [ApprovalMode.Auto, ApprovalMode.Manual]) {
    test(`goes ahead under ${mode} approval chosen at launch`, async () => {
      approval.mode = mode;

      assert.match(await handler(plan), /approved under the approval mode/);
      assert.equal(approval.mode, mode);
      assert.equal(takeYield(), false);
    });
  }
});
