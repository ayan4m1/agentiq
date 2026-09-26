import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

import {
  alwaysExclude,
  gitVisible,
  projectFiles,
  toPosix,
  visibleDirectories
} from './ignore';

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-ignore-'));
const repo = resolve(root, 'repo');
const plain = resolve(root, 'plain');

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

before(() => {
  mkdirSync(resolve(repo, 'src'), { recursive: true });
  mkdirSync(resolve(repo, 'lib'), { recursive: true });
  mkdirSync(resolve(repo, 'secrets'), { recursive: true });
  mkdirSync(plain, { recursive: true });

  writeFileSync(resolve(repo, '.gitignore'), 'lib/\nsecrets/\n*.log\n');
  writeFileSync(resolve(repo, 'src', 'index.ts'), 'export const a = 1;');
  writeFileSync(resolve(repo, 'src', 'helper.ts'), 'export const b = 2;');
  writeFileSync(resolve(repo, 'lib', 'index.js'), 'compiled');
  writeFileSync(resolve(repo, 'secrets', 'key.txt'), 'shh');
  writeFileSync(resolve(repo, 'debug.log'), 'noise');
  writeFileSync(resolve(repo, 'README.md'), '# repo');
  // not in the .gitignore, so only the guard keeps it out
  mkdirSync(resolve(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(resolve(repo, 'node_modules', 'pkg', 'index.js'), 'dep');

  mkdirSync(resolve(plain, 'sub'), { recursive: true });
  mkdirSync(resolve(plain, 'node_modules'), { recursive: true });
  writeFileSync(resolve(plain, 'top.txt'), 'top');
  writeFileSync(resolve(plain, 'sub', 'inner.txt'), 'inner');
  writeFileSync(resolve(plain, 'node_modules', 'dep.js'), 'dep');

  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
});

describe('alwaysExclude', () => {
  test('still guards the directories that are never interesting', () => {
    assert.ok(
      alwaysExclude.some((pattern) => pattern.includes('node_modules'))
    );
    assert.ok(alwaysExclude.some((pattern) => pattern.includes('.git')));
  });

  test('no longer hides build output by name', () => {
    // lib/ was agentiq's own build directory. in a project where lib/ holds
    // sources, hardcoding it made the agent blind to them with no explanation
    assert.ok(!alwaysExclude.some((pattern) => pattern.includes('lib')));
  });
});

describe('gitVisible', () => {
  test('shows a file that is tracked or merely untracked', () => {
    const visible = gitVisible(repo);

    assert.ok(visible?.has('src/index.ts'));
    assert.ok(visible?.has('README.md'));
  });

  test('hides a directory named in .gitignore', () => {
    const visible = gitVisible(repo);

    assert.ok(!visible?.has('lib/index.js'));
    assert.ok(!visible?.has('secrets/key.txt'));
  });

  test('hides a file matched by a pattern', () => {
    assert.ok(!gitVisible(repo)?.has('debug.log'));
  });

  test('answers with forward slashes, whatever the platform', () => {
    for (const path of gitVisible(repo) ?? []) {
      assert.ok(!path.includes('\\'), `${path} should be posix`);
    }
  });

  test('returns nothing outside a repository, so the caller can fall back', () => {
    assert.equal(gitVisible(plain), undefined);
  });
});

describe('projectFiles', () => {
  test('lists what git shows in a repository', () => {
    const files = projectFiles(repo);

    assert.ok(files.has('src/index.ts'));
    assert.ok(files.has('README.md'));
    assert.ok(!files.has('lib/index.js'));
    assert.ok(!files.has('debug.log'));
  });

  test('drops node_modules even when no .gitignore mentions it', () => {
    assert.ok(!projectFiles(repo).has('node_modules/pkg/index.js'));
  });

  test('falls back to a guarded glob outside a repository', () => {
    assert.deepEqual([...projectFiles(plain)].sort(), [
      'sub/inner.txt',
      'top.txt'
    ]);
  });
});

describe('visibleDirectories', () => {
  test('offers every ancestor of a visible file', () => {
    const directories = visibleDirectories(
      new Set(['src/deep/nested/file.ts'])
    );

    assert.deepEqual([...directories].sort(), [
      'src',
      'src/deep',
      'src/deep/nested'
    ]);
  });

  test('offers nothing for a file at the top level', () => {
    assert.equal(visibleDirectories(new Set(['README.md'])).size, 0);
  });

  test('does not offer a directory holding nothing visible', () => {
    const directories = visibleDirectories(new Set(['src/index.ts']));

    assert.ok(!directories.has('lib'));
  });

  test('offers nothing at all for an empty set', () => {
    assert.equal(visibleDirectories(new Set()).size, 0);
  });
});

describe('toPosix', () => {
  test('leaves a posix path alone', () => {
    assert.equal(toPosix('src/modules/ignore.ts'), 'src/modules/ignore.ts');
  });
});
