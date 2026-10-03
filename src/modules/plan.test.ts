import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

// the plan path is resolved from the working directory and AQ_HOME when the
// module loads, so it has to be imported from inside a scratch project with a
// scratch home
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-plan-'));
const project = resolve(root, 'project');
const home = resolve(root, 'home');
const original = process.cwd();

mkdirSync(project);
process.env.AQ_HOME = home;
process.chdir(project);

const { planPath, readPlan, serializePlan, writePlan } = await import('./plan');
const { slugFor } = await import('../utils');

process.chdir(original);

const read = () => readFileSync(planPath).toString();

beforeEach(() => {
  rmSync(resolve(home, 'plans'), { recursive: true, force: true });
});

describe('planPath', () => {
  test('sits under AQ_HOME, keyed by the project it was loaded from', () => {
    assert.equal(planPath, resolve(home, 'plans', `${slugFor(project)}.md`));
  });

  test('is outside the project', () => {
    assert.ok(!planPath.startsWith(project));
  });
});

describe('serializePlan', () => {
  test('lays out the title and numbered steps', () => {
    assert.equal(
      serializePlan({
        title: 'Add tests',
        steps: ['Read the module', 'Write the suite', 'Run it']
      }),
      '# Add tests\n\n1. Read the module\n2. Write the suite\n3. Run it\n'
    );
  });

  test('numbers from one in the order given', () => {
    // a step the user approved as "3." has to still be step 3 when read back
    const steps = Array.from({ length: 12 }, (_, index) => `Step ${index}`);
    const lines = serializePlan({ title: 'Long', steps }).trimEnd().split('\n');

    assert.equal(lines[2], '1. Step 0');
    assert.equal(lines[13], '12. Step 11');
  });

  test('keeps a trailing newline and no trailing whitespace', () => {
    const text = serializePlan({ title: 'Plan', steps: ['Only step'] });

    assert.match(text, /[^\n]\n$/);
    assert.doesNotMatch(text, /[ \t]\n/);
  });

  test('is just the title when there are no steps', () => {
    assert.equal(serializePlan({ title: 'Empty', steps: [] }), '# Empty\n');
  });

  test('passes step text through verbatim', () => {
    assert.equal(
      serializePlan({ title: 'Plan', steps: ['Use `node:test` & **bold**'] }),
      '# Plan\n\n1. Use `node:test` & **bold**\n'
    );
  });
});

describe('writePlan', () => {
  test('creates the file with the serialized plan', () => {
    const plan = { title: 'Plan', steps: ['First', 'Second'] };

    writePlan(plan);

    assert.ok(existsSync(planPath));
    assert.equal(read(), serializePlan(plan));
  });

  test('creates the plans directory when there is none yet', () => {
    assert.ok(!existsSync(resolve(home, 'plans')));

    writePlan({ title: 'Plan', steps: [] });

    assert.ok(existsSync(planPath));
  });

  test('leaves the project directory untouched', () => {
    writePlan({ title: 'Plan', steps: ['Only step'] });

    assert.deepEqual(readdirSync(project), []);
  });

  test('replaces the previous plan rather than appending to it', () => {
    writePlan({ title: 'Old', steps: ['Stale step'] });
    writePlan({ title: 'New', steps: ['Fresh step'] });

    assert.equal(read(), '# New\n\n1. Fresh step\n');
  });
});

describe('readPlan', () => {
  test('is undefined when there is no file', () => {
    assert.equal(readPlan(), undefined);
  });

  test('is the file verbatim when there is one', () => {
    // hand edits are handed back as they are, not reparsed
    const content = '# Edited by hand\r\n\r\n- not numbered\r\n';

    mkdirSync(resolve(home, 'plans'), { recursive: true });
    writeFileSync(planPath, content);

    assert.equal(readPlan(), content);
  });
});
