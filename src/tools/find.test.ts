import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

import { handler } from './find';

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-find-'));
const repo = resolve(root, 'repo');
const original = process.cwd();

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

// glob answers in platform separators
const lines = (output: string) =>
  output.split('\n').map((line) => line.replaceAll('\\', '/'));

before(() => {
  mkdirSync(resolve(repo, 'src'), { recursive: true });
  mkdirSync(resolve(repo, 'build'), { recursive: true });
  mkdirSync(resolve(repo, 'node_modules', 'left-pad'), { recursive: true });

  writeFileSync(resolve(repo, '.gitignore'), 'build/\n');
  writeFileSync(resolve(repo, 'README.md'), '# repo');
  writeFileSync(
    resolve(repo, 'src', 'greet.ts'),
    'const a = 1;\nHello World\n'
  );
  writeFileSync(resolve(repo, 'src', 'other.ts'), 'nothing to see\n');
  writeFileSync(resolve(repo, 'build', 'greet.ts'), 'Hello World\n');
  writeFileSync(resolve(repo, 'node_modules', 'left-pad', 'pad.ts'), 'Hello');

  git('init');
});

after(() => {
  process.chdir(original);
});

describe('find', () => {
  test('lists the files matching a pattern', async () => {
    const found = lines(await handler({ pattern: '**/*.ts', path: repo }));

    assert.match(found[0], /^2 file\(s\) matching \*\*\/\*\.ts/);
    assert.ok(found.includes('src/greet.ts'));
    assert.ok(found.includes('src/other.ts'));
  });

  test('hides what git ignores', async () => {
    const found = lines(await handler({ pattern: '**/*.ts', path: repo }));

    assert.ok(!found.includes('build/greet.ts'));
  });

  test('hides dependencies', async () => {
    const found = lines(await handler({ pattern: '**/*.ts', path: repo }));

    assert.ok(!found.some((line) => line.includes('left-pad')));
  });

  test('lists files but not directories', async () => {
    const found = lines(await handler({ pattern: '*', path: repo }));

    assert.ok(found.includes('README.md'));
    assert.ok(!found.includes('src'));
  });

  test('searches the working directory when given no path', async () => {
    process.chdir(repo);

    try {
      assert.ok(
        lines(await handler({ pattern: 'src/*.ts' })).includes('src/greet.ts')
      );
    } finally {
      process.chdir(original);
    }
  });

  test('says so when no file matches', async () => {
    assert.equal(
      await handler({ pattern: '**/*.rs', path: repo }),
      `No files matched **/*.rs in ${repo}`
    );
  });

  test('reports the file and line of a content match', async () => {
    const found = lines(
      await handler({ pattern: '**/*.ts', path: repo, content: 'Hello' })
    );

    assert.equal(found[0], '1 match(es) for Hello in **/*.ts:');
    assert.equal(found[1], 'src/greet.ts:2:Hello World');
  });

  test('matches content by case unless told otherwise', async () => {
    assert.equal(
      await handler({ pattern: '**/*.ts', path: repo, content: 'hello' }),
      'Searched 2 file(s) matching **/*.ts; nothing matched hello'
    );
    assert.match(
      await handler({
        pattern: '**/*.ts',
        path: repo,
        content: 'hello',
        caseInsensitive: true
      }),
      /greet\.ts:2:Hello World/
    );
  });

  test('treats content as a regular expression', async () => {
    assert.match(
      await handler({
        pattern: '**/*.ts',
        path: repo,
        content: '^const \\w+ ='
      }),
      /greet\.ts:1:const a = 1;/
    );
  });
});
