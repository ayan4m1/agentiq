import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// read when the module first evaluates, so the real rules are never touched
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-rules-'));
const stateDir = resolve(root, 'state');

process.env.AQ_HOME = stateDir;

const { isRemembered, load, matchesRule, normalizePath, remember } =
  await import('./rules');
const { slugFor } = await import('../utils');

const projectA = resolve(root, 'project-a');
const projectB = resolve(root, 'project-b');
const original = process.cwd();

const rulesFor = (cwd: string) =>
  resolve(stateDir, 'approvals', `${slugFor(cwd)}.json`);

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

    assert.deepEqual(load().command, ['yarn test']);
  });

  test('says nothing about another project', () => {
    remember('command', 'yarn test');
    process.chdir(projectB);

    // an answer given about one project is not an answer about another
    assert.equal(isRemembered('command', 'yarn test'), false);
  });

  test('honours a pattern written into the file by hand', () => {
    mkdirSync(resolve(stateDir, 'approvals'), { recursive: true });
    writeFileSync(
      rulesFor(projectA),
      JSON.stringify({ command: [], path: ['src/**'] })
    );

    assert.ok(isRemembered('path', 'src/modules/deep.ts'));
    assert.equal(isRemembered('path', 'other/deep.ts'), false);
  });

  test('survives a rules file that will not parse', () => {
    mkdirSync(resolve(stateDir, 'approvals'), { recursive: true });
    writeFileSync(rulesFor(projectA), 'not json at all');

    assert.deepEqual(load(), { command: [], path: [] });
    assert.equal(isRemembered('command', 'anything'), false);
  });

  test('survives a rules file holding the wrong shape', () => {
    mkdirSync(resolve(stateDir, 'approvals'), { recursive: true });
    writeFileSync(rulesFor(projectA), JSON.stringify({ command: 'nope' }));

    assert.deepEqual(load().command, []);
  });
});
