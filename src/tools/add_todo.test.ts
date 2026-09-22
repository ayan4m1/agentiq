import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

// the roadmap path is resolved from the working directory when the module
// loads, so the tool has to be imported from inside the scratch project
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-add-todo-'));
const original = process.cwd();

process.chdir(root);

const { handler } = await import('./add_todo');
const { readRoadmap, roadmapPath } = await import('../modules/roadmap');

process.chdir(original);

const read = () => readFileSync(roadmapPath).toString();

// renderDiff prints the change it is about to make, which is the point of it
// in the REPL and only noise here
const quietly = async <T>(work: () => Promise<T>) => {
  const spoke = console.log;

  console.log = () => {};

  try {
    return await work();
  } finally {
    console.log = spoke;
  }
};

const add = (text: string) => quietly(() => handler({ text }));

beforeEach(() => {
  rmSync(roadmapPath, { force: true });
});

describe('handler', () => {
  test('creates the roadmap when there is none yet', async () => {
    const result = await add('Write the parser');

    assert.ok(existsSync(roadmapPath));
    assert.deepEqual(readRoadmap().todos, [
      { text: 'Write the parser', done: false, doneAt: undefined }
    ]);
    assert.match(result, /Added "Write the parser" to the todo list/);
    assert.match(result, /1\. \[ \] Write the parser/);
  });

  test('appends after the existing objectives', async () => {
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## Todo\n\n- [ ] First\n- [x] Second\n'
    );

    const result = await add('Third');

    assert.deepEqual(
      readRoadmap().todos.map(({ text, done }) => [text, done]),
      [
        ['First', false],
        ['Second', true],
        ['Third', false]
      ]
    );
    assert.match(result, /3\. \[ \] Third/);
  });

  test('collapses line breaks and extra spacing into a single line', async () => {
    await add('  Split\nacross   lines\t ');

    assert.equal(readRoadmap().todos[0].text, 'Split across lines');
    assert.match(read(), /^- \[ \] Split across lines$/m);
  });

  test('refuses blank text without writing anything', async () => {
    const result = await add(' \n\t ');

    assert.match(result, /needs some text/);
    assert.equal(existsSync(roadmapPath), false);
  });

  test('refuses an objective that is already open, ignoring case and spacing', async () => {
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## Todo\n\n- [ ] Write the parser\n'
    );

    const before = read();
    const result = await add('write  THE parser');

    assert.match(result, /"Write the parser" is already on the todo list/);
    assert.match(result, /nothing was added/);
    assert.equal(read(), before);
  });

  test('re-adds a completed objective and says when it was done', async () => {
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## Todo\n\n- [x] Fix the build <!-- done 2026-01-02 -->\n'
    );

    const result = await add('Fix the build');

    assert.deepEqual(
      readRoadmap().todos.map(({ text, done }) => [text, done]),
      [
        ['Fix the build', true],
        ['Fix the build', false]
      ]
    );
    assert.match(result, /completed before on 2026-01-02/);
  });

  test('mentions an earlier completion even without a date', async () => {
    writeFileSync(roadmapPath, '# Roadmap\n\n## Todo\n\n- [x] Fix the build\n');

    const result = await add('Fix the build');

    assert.match(result, /The same objective was completed before\./);
  });

  test('keeps the rest of the file intact', async () => {
    writeFileSync(
      roadmapPath,
      '# Plans\n\nIntro text.\n\n## Todo\n\n- [ ] First\n\n## Notes\n\nRemember this.\n\n## Other\n\nKeep me.\n'
    );

    await add('Second');

    const roadmap = readRoadmap();

    assert.equal(roadmap.title, '# Plans');
    assert.equal(roadmap.preamble, 'Intro text.');
    assert.equal(roadmap.notes, 'Remember this.');
    assert.equal(roadmap.extra, '## Other\n\nKeep me.');
  });

  test('keeps CRLF line endings', async () => {
    writeFileSync(
      roadmapPath,
      '# Roadmap\r\n\r\n## Todo\r\n\r\n- [ ] First\r\n'
    );

    await add('Second');

    assert.doesNotMatch(read(), /[^\r]\n/);
    assert.match(read(), /- \[ \] Second\r\n/);
  });
});
