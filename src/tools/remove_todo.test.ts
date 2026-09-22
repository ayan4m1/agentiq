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
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-remove-todo-'));
const original = process.cwd();

process.chdir(root);

const { handler } = await import('./remove_todo');
const { readRoadmap, roadmapPath } = await import('../modules/roadmap');

process.chdir(original);

const read = () => readFileSync(roadmapPath).toString();

const roadmapWith = (...items: string[]) =>
  writeFileSync(roadmapPath, `# Roadmap\n\n## Todo\n\n${items.join('\n')}\n`);

const texts = () => readRoadmap().todos.map(({ text }) => text);

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

const remove = (todo: string) => quietly(() => handler({ todo }));

beforeEach(() => {
  rmSync(roadmapPath, { force: true });
});

describe('handler', () => {
  test('says the list is empty when there is no roadmap', async () => {
    const result = await remove('1');

    assert.match(result, /todo list in ROADMAP\.md is empty/);
    assert.equal(existsSync(roadmapPath), false);
  });

  test('removes an objective by number', async () => {
    roadmapWith('- [ ] First', '- [ ] Second', '- [ ] Third');

    const result = await remove('2');

    assert.deepEqual(texts(), ['First', 'Third']);
    assert.match(result, /Deleted "Second" from the roadmap/);
    assert.doesNotMatch(result, /already marked done/);
    // the list handed back is renumbered to match the file
    assert.match(result, /2\. \[ \] Third/);
  });

  test('removes an objective by its wording', async () => {
    roadmapWith('- [ ] Write the parser', '- [ ] Ship it');

    await remove('write the PARSER');

    assert.deepEqual(texts(), ['Ship it']);
  });

  test('prefers an exact match over a longer one containing it', async () => {
    roadmapWith('- [ ] Add tests for the parser', '- [ ] Add tests');

    await remove('add tests');

    assert.deepEqual(texts(), ['Add tests for the parser']);
  });

  test('warns when the objective removed was already done', async () => {
    roadmapWith('- [x] First <!-- done 2026-01-01 -->', '- [ ] Second');

    const result = await remove('1');

    assert.deepEqual(texts(), ['Second']);
    assert.match(result, /already marked done, so that record is gone/);
  });

  test('leaves an empty todo section behind after removing the last one', async () => {
    roadmapWith('- [ ] Only');

    const result = await remove('1');

    assert.deepEqual(texts(), []);
    assert.match(read(), /## Todo/);
    assert.match(result, /\(the todo list is empty\)/);
  });

  test('refuses a number outside the list', async () => {
    roadmapWith('- [ ] First');

    const before = read();
    const result = await remove('0');

    assert.match(result, /There is no objective number 0/);
    assert.equal(read(), before);
  });

  test('refuses wording that matches nothing', async () => {
    roadmapWith('- [ ] First');

    const before = read();
    const result = await remove('missing');

    assert.match(result, /No objective matches "missing"/);
    assert.match(result, /The todo list is now:/);
    assert.equal(read(), before);
  });

  test('refuses wording that matches more than one objective', async () => {
    roadmapWith('- [ ] Fix the lexer', '- [ ] Fix the parser');

    const before = read();
    const result = await remove('fix the');

    assert.match(result, /2 objectives match "fix the"/);
    assert.match(result, /1\. Fix the lexer/);
    assert.match(result, /2\. Fix the parser/);
    assert.equal(read(), before);
  });

  test('removes only one of two objectives with the same text', async () => {
    roadmapWith('- [x] Fix the build', '- [ ] Fix the build');

    await remove('2');

    assert.deepEqual(
      readRoadmap().todos.map(({ done }) => done),
      [true]
    );
  });

  test('keeps notes and other sections intact', async () => {
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## Todo\n\n- [ ] First\n- [ ] Second\n\n## Notes\n\nRemember this.\n\n## Other\n\nKeep me.\n'
    );

    await remove('First');

    const roadmap = readRoadmap();

    assert.equal(roadmap.notes, 'Remember this.');
    assert.equal(roadmap.extra, '## Other\n\nKeep me.');
  });
});
