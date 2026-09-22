import { test, describe, beforeEach, afterEach, mock } from 'node:test';
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
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-complete-todo-'));
const original = process.cwd();

process.chdir(root);

const { handler } = await import('./complete_todo');
const { readRoadmap, roadmapPath } = await import('../modules/roadmap');

process.chdir(original);

const read = () => readFileSync(roadmapPath).toString();

const roadmapWith = (...items: string[]) =>
  writeFileSync(roadmapPath, `# Roadmap\n\n## Todo\n\n${items.join('\n')}\n`);

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

const complete = (todo: string) => quietly(() => handler({ todo }));

beforeEach(() => {
  rmSync(roadmapPath, { force: true });
  // the completion date is stamped from the clock
  mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-03-04T12:00:00Z')
  });
});

afterEach(() => {
  mock.timers.reset();
});

describe('handler', () => {
  test('says the list is empty when there is no roadmap', async () => {
    const result = await complete('1');

    assert.match(result, /todo list in ROADMAP\.md is empty/);
    assert.equal(existsSync(roadmapPath), false);
  });

  test('says so when every objective is already complete', async () => {
    roadmapWith('- [x] First', '- [x] Second');

    const before = read();
    const result = await complete('First');

    assert.match(result, /already complete/);
    assert.match(result, /add_todo/);
    assert.equal(read(), before);
  });

  test('completes an objective by number and stamps the date', async () => {
    roadmapWith('- [ ] First', '- [ ] Second');

    const result = await complete('2');

    assert.deepEqual(readRoadmap().todos, [
      { text: 'First', done: false, doneAt: undefined },
      { text: 'Second', done: true, doneAt: '2026-03-04' }
    ]);
    assert.match(read(), /^- \[x\] Second <!-- done 2026-03-04 -->$/m);
    assert.match(result, /Marked "Second" as done/);
    assert.match(result, /2\. \[x\] Second \(done 2026-03-04\)/);
  });

  test('completes an objective by part of its wording', async () => {
    roadmapWith('- [ ] Write the parser', '- [ ] Ship it');

    await complete('the PARSER');

    assert.deepEqual(
      readRoadmap().todos.map(({ done }) => done),
      [true, false]
    );
  });

  test('counts completed objectives when resolving a number', async () => {
    roadmapWith('- [x] First', '- [ ] Second');

    await complete('2');

    assert.deepEqual(
      readRoadmap().todos.map(({ done }) => done),
      [true, true]
    );
  });

  test('refuses an objective that is already done', async () => {
    roadmapWith('- [x] First <!-- done 2026-01-01 -->', '- [ ] Second');

    const before = read();
    const result = await complete('1');

    assert.match(result, /"First" was already marked complete/);
    assert.equal(read(), before);
  });

  test('refuses a number outside the list and shows the list', async () => {
    roadmapWith('- [ ] First');

    const before = read();
    const result = await complete('5');

    assert.match(result, /There is no objective number 5/);
    assert.match(result, /The todo list is now:/);
    assert.equal(read(), before);
  });

  test('refuses wording that matches nothing', async () => {
    roadmapWith('- [ ] First');

    const before = read();
    const result = await complete('nothing like it');

    assert.match(result, /No objective matches "nothing like it"/);
    assert.equal(read(), before);
  });

  test('refuses wording that matches more than one objective', async () => {
    roadmapWith('- [ ] Add tests for add', '- [ ] Add tests for remove');

    const before = read();
    const result = await complete('add tests');

    assert.match(result, /2 objectives match "add tests"/);
    assert.equal(read(), before);
  });

  test('refuses an empty target', async () => {
    roadmapWith('- [ ] First');

    const before = read();
    const result = await complete('  ');

    assert.match(result, /No objective was named/);
    assert.equal(read(), before);
  });

  test('completes only one of two objectives with the same text', async () => {
    roadmapWith('- [x] Fix the build', '- [ ] Fix the build');

    await complete('2');

    const [first, second] = readRoadmap().todos;

    assert.equal(first.doneAt, undefined);
    assert.equal(second.doneAt, '2026-03-04');
  });
});
