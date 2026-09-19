import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

import { handler } from './list';

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-list-'));
const repo = resolve(root, 'repo');
const plain = resolve(root, 'plain');

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

before(() => {
  mkdirSync(resolve(repo, 'src', 'modules'), { recursive: true });
  mkdirSync(resolve(repo, 'build'), { recursive: true });
  mkdirSync(resolve(repo, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(resolve(plain, 'anything'), { recursive: true });

  writeFileSync(resolve(repo, '.gitignore'), 'build/\n');
  writeFileSync(resolve(repo, 'README.md'), '# repo');
  writeFileSync(resolve(repo, 'src', 'index.ts'), 'export const a = 1;');
  writeFileSync(
    resolve(repo, 'src', 'modules', 'deep.ts'),
    'export const b = 2;'
  );
  writeFileSync(resolve(repo, 'build', 'output.js'), 'compiled');
  writeFileSync(resolve(repo, 'node_modules', 'left-pad', 'index.js'), 'dep');
  writeFileSync(resolve(plain, 'loose.txt'), 'no repository here');

  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
});

describe('list', () => {
  test('lists what is directly inside a directory', async () => {
    const output = String(await handler({ path: repo }));

    assert.match(output, /README\.md/);
    assert.match(output, /src\//);
  });

  test('reports the size of a file', async () => {
    assert.match(String(await handler({ path: repo })), /README\.md\s+\d+\s*B/);
  });

  test('stays at one level unless asked to go deeper', async () => {
    const output = String(await handler({ path: repo }));

    assert.doesNotMatch(output, /index\.ts/);
  });

  test('descends when given a depth', async () => {
    const output = String(await handler({ path: repo, depth: 2 }));

    assert.match(output, /index\.ts/);
    // three levels down, so still out of reach at depth two
    assert.doesNotMatch(output, /deep\.ts/);
  });

  test('reaches the bottom when given enough depth', async () => {
    assert.match(String(await handler({ path: repo, depth: 3 })), /deep\.ts/);
  });

  test('hides what git ignores', async () => {
    const output = String(await handler({ path: repo, depth: 3 }));

    assert.doesNotMatch(output, /build/);
    assert.doesNotMatch(output, /output\.js/);
  });

  test('hides dependencies even though git has no opinion on them', async () => {
    const output = String(await handler({ path: repo, depth: 3 }));

    assert.doesNotMatch(output, /left-pad/);
  });

  test('still works outside a repository', async () => {
    const output = String(await handler({ path: plain }));

    assert.match(output, /loose\.txt/);
    assert.match(output, /anything\//);
  });

  test('treats a depth below one as one rather than listing nothing', async () => {
    assert.match(String(await handler({ path: repo, depth: 0 })), /README\.md/);
  });

  test('says so plainly when there is nothing to show', async () => {
    const empty = resolve(root, 'empty');

    mkdirSync(empty, { recursive: true });

    assert.match(String(await handler({ path: empty })), /empty/);
  });

  test('defaults to the working directory', async () => {
    const output = String(await handler({}));

    assert.ok(output.includes(process.cwd().split(/[\\/]/).pop() ?? ''));
  });
});
