import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fsp from 'node:fs/promises';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';

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

  test('skips a match that cannot be inspected', async () => {
    // outside the repository, so git filters nothing before the stat
    const loose = resolve(root, 'loose');
    const gone = resolve(root, 'gone');

    mkdirSync(gone, { recursive: true });
    mkdirSync(loose, { recursive: true });
    writeFileSync(resolve(loose, 'kept.txt'), 'kept');
    // a junction needs no privileges on Windows and is ignored elsewhere
    symlinkSync(gone, resolve(loose, 'dangling'), 'junction');
    rmSync(gone, { recursive: true });

    const found = lines(await handler({ pattern: '*', path: loose }));

    assert.match(found[0], /^1 file\(s\) matching \*/);
    assert.ok(found.includes('kept.txt'));
    assert.ok(!found.includes('dangling'));
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

  test('stops at the file limit and says so', async (t) => {
    // its own directory keeps these out of the patterns other tests use
    const lots = resolve(repo, 'lots');

    mkdirSync(lots);
    t.after(() => rmSync(lots, { recursive: true }));

    for (let i = 0; i < 101; i++) {
      writeFileSync(resolve(lots, `${i}.txt`), '');
    }

    const found = lines(await handler({ pattern: 'lots/*.txt', path: repo }));

    assert.match(found[0], /^100 file\(s\) matching lots\/\*\.txt/);
    assert.equal(found.at(-1), '[truncated at 100 files - narrow the pattern]');
    assert.equal(found.length, 102);
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

  test('skips a file that cannot be read and searches the rest', async (t) => {
    const realReadFile = fsp.readFile;

    t.mock.method(fsp, 'readFile', (path: string, ...rest: []) =>
      String(path).endsWith('greet.ts')
        ? Promise.reject(new Error('EACCES'))
        : realReadFile(path, ...rest)
    );
    // find imports readFile by name, which only follows the swap once synced
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const found = lines(
      await handler({ pattern: '**/*.ts', path: repo, content: 'Hello|see' })
    );

    assert.equal(found[0], '1 match(es) for Hello|see in **/*.ts:');
    assert.equal(found[1], 'src/other.ts:1:nothing to see');
  });

  test('stops at the match limit and says so', async (t) => {
    // .txt keeps it out of the **/*.ts counts the other tests rely on
    const many = resolve(repo, 'src', 'many.txt');

    writeFileSync(
      many,
      Array.from({ length: 250 }, (_, i) => `match ${i}`).join('\n')
    );
    t.after(() => rmSync(many));

    const found = lines(
      await handler({ pattern: '**/*.txt', path: repo, content: 'match' })
    );

    assert.equal(found[0], '200 match(es) for match in **/*.txt:');
    assert.equal(found[200], 'src/many.txt:200:match 199');
    assert.equal(
      found.at(-1),
      '[truncated at 200 matches - narrow the search]'
    );
    assert.equal(found.length, 202);
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
