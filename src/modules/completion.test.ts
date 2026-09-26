import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// the listing is git's business and tested with it - here it only has to be
// counted, to show the index asks once and asks again when told to
let listed: string[];
const projectFiles = mock.fn<(cwd: string) => Set<string>>(
  () => new Set(listed)
);

mock.module('./ignore', {
  namedExports: {
    projectFiles,
    visibleDirectories: (files: Set<string>) => {
      const directories = new Set<string>();

      for (const file of files) {
        const parts = file.split('/').slice(0, -1);

        parts.forEach((_, index) =>
          directories.add(parts.slice(0, index + 1).join('/'))
        );
      }

      return directories;
    }
  }
});

const { complete, createPathIndex, shortCompletions } =
  await import('./completion');

const commands = ['context', 'context-limit', 'compact', 'help'];

// a fixed tree, and a count of how often it was asked for
const tree = (files: string[]) => {
  const reads = { files: 0, directories: 0 };
  const directories = new Set(['src', 'src/modules', 'test']);

  return {
    reads,
    sources: {
      commands,
      paths: {
        get files() {
          reads.files++;

          return new Set(files);
        },
        get directories() {
          reads.directories++;

          return directories;
        }
      }
    }
  };
};

const project = [
  'README.md',
  'package.json',
  'src/index.ts',
  'src/modules/repl.ts',
  'src/modules/ignore.ts',
  'test/register.mjs'
];

beforeEach(() => {
  listed = [];
  projectFiles.mock.resetCalls();
});

describe('complete', () => {
  test('offers every command after a slash', () => {
    const { sources } = tree(project);

    assert.deepEqual(complete('/co', sources), [
      '/context',
      '/context-limit',
      '/compact',
      '/help'
    ]);
  });

  test('offers nothing once a command has its argument started', () => {
    assert.deepEqual(complete('/recap 5', tree(project).sources), []);
  });

  test('does not list the project to complete a command', () => {
    const { reads, sources } = tree(project);

    complete('/', sources);

    assert.deepEqual(reads, { files: 0, directories: 0 });
  });

  test('offers the top level of the project after a bare @', () => {
    assert.deepEqual(complete('@', tree(project).sources), [
      '@README.md',
      '@package.json',
      '@src/',
      '@test/'
    ]);
  });

  test('offers only the children of the directory being typed', () => {
    assert.deepEqual(complete('@src/mo', tree(project).sources), [
      '@src/index.ts',
      '@src/modules/'
    ]);
    assert.deepEqual(complete('@src/modules/', tree(project).sources), [
      '@src/modules/ignore.ts',
      '@src/modules/repl.ts'
    ]);
  });

  test('keeps whatever was typed before the mention', () => {
    assert.deepEqual(complete('explain @test/', tree(project).sources), [
      'explain @test/register.mjs'
    ]);
  });

  test('offers nothing for a word that is not a mention', () => {
    const { reads, sources } = tree(project);

    assert.deepEqual(complete('explain src', sources), []);
    assert.deepEqual(complete('', sources), []);
    assert.equal(reads.files, 0);
  });
});

describe('shortCompletions', () => {
  test('lists only the word being completed', () => {
    assert.deepEqual(
      shortCompletions('explain @src/', [
        'explain @src/index.ts',
        'explain @src/modules/'
      ]),
      ['@src/index.ts', '@src/modules/']
    );
  });

  test('leaves a command alone', () => {
    assert.deepEqual(shortCompletions('/c', ['/context', '/compact']), [
      '/context',
      '/compact'
    ]);
  });
});

describe('createPathIndex', () => {
  test('lists nothing until it is asked', () => {
    createPathIndex('/project');

    assert.equal(projectFiles.mock.callCount(), 0);
  });

  test('lists once, for files and directories alike', () => {
    listed = ['src/index.ts'];

    const index = createPathIndex('/project');

    assert.deepEqual([...index.files], ['src/index.ts']);
    assert.deepEqual([...index.directories], ['src']);
    assert.deepEqual([...index.files], ['src/index.ts']);
    assert.equal(projectFiles.mock.callCount(), 1);
    assert.deepEqual(projectFiles.mock.calls[0].arguments, ['/project']);
  });

  test('lists again once invalidated', () => {
    const index = createPathIndex('/project');

    listed = ['old.ts'];
    assert.deepEqual([...index.files], ['old.ts']);

    listed = ['new.ts'];
    index.invalidate();
    assert.deepEqual([...index.directories], []);
    assert.deepEqual([...index.files], ['new.ts']);
    assert.equal(projectFiles.mock.callCount(), 2);
  });
});
