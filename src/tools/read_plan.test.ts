import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// the plan path is resolved from the working directory when the module loads,
// so the tool has to be imported from inside a scratch project
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-read-plan-'));
const original = process.cwd();

process.chdir(root);

const { handler } = await import('./read_plan');
const { planPath, writePlan } = await import('../modules/plan');

process.chdir(original);

beforeEach(() => {
  rmSync(planPath, { force: true });
});

describe('read_plan', () => {
  test('says so when no plan has been presented', async () => {
    assert.match(await handler(), /There is no PLAN\.md yet/);
  });

  test('returns the saved plan', async () => {
    writePlan({ title: 'Ship it', steps: ['Build', 'Release'] });

    assert.equal(await handler(), '# Ship it\n\n1. Build\n2. Release\n');
  });
});
