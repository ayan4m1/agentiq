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
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-update-notes-'));
const original = process.cwd();

process.chdir(root);

const { handler } = await import('./update_notes');
const { notesBudget, readRoadmap, roadmapPath } =
  await import('../modules/roadmap');

process.chdir(original);

const read = () => readFileSync(roadmapPath).toString();

const notesWith = (notes: string) =>
  writeFileSync(
    roadmapPath,
    `# Roadmap\n\n## Todo\n\n- [ ] First\n\n## Notes\n\n${notes}\n`
  );

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

const update = (text: string, replace?: boolean) =>
  quietly(() => handler({ text, replace }));

beforeEach(() => {
  rmSync(roadmapPath, { force: true });
});

describe('handler', () => {
  test('creates the roadmap with the note when there is none yet', async () => {
    const result = await update('Builds use rollup.');

    assert.ok(existsSync(roadmapPath));
    assert.equal(readRoadmap().notes, 'Builds use rollup.');
    assert.equal(
      result,
      'Appended 18 characters to the Notes section of ROADMAP.md; it is now 18 characters.'
    );
  });

  test('appends below the existing notes with a blank line between', async () => {
    notesWith('First fact.');

    const result = await update('  Second fact.  ');

    assert.equal(readRoadmap().notes, 'First fact.\n\nSecond fact.');
    assert.match(result, /Appended 12 characters/);
    assert.match(result, /it is now 25 characters/);
  });

  test('replaces the whole section when asked', async () => {
    notesWith('Old fact.\n\nAnother old fact.');

    const result = await update('Condensed.', true);

    assert.equal(readRoadmap().notes, 'Condensed.');
    assert.equal(
      result,
      'Replaced the Notes section of ROADMAP.md; it is now 10 characters.'
    );
  });

  test('clears the section with an empty replacement', async () => {
    notesWith('Old fact.');

    const result = await update('   ', true);

    assert.equal(readRoadmap().notes, '');
    assert.match(read(), /## Notes\n$/);
    assert.match(result, /it is now 0 characters/);
  });

  test('refuses an empty note when appending', async () => {
    notesWith('Old fact.');

    const before = read();
    const result = await update(' \n ');

    assert.match(result, /needs some text/);
    assert.match(result, /replace to true/);
    assert.equal(read(), before);
  });

  test('demotes level two headings so they cannot end the section', async () => {
    notesWith('Old fact.');

    await update('## Decisions\nUse tabs.\n### Kept\n#### Also kept');

    const roadmap = readRoadmap();

    assert.equal(
      roadmap.notes,
      'Old fact.\n\n### Decisions\nUse tabs.\n### Kept\n#### Also kept'
    );
    // nothing leaked out into a section of its own
    assert.equal(roadmap.extra, '');
  });

  test('leaves the todo list and other sections intact', async () => {
    writeFileSync(
      roadmapPath,
      '# Roadmap\n\n## Todo\n\n- [ ] First\n\n## Notes\n\nOld fact.\n\n## Other\n\nKeep me.\n'
    );

    await update('New fact.');

    const roadmap = readRoadmap();

    assert.deepEqual(
      roadmap.todos.map(({ text }) => text),
      ['First']
    );
    assert.equal(roadmap.notes, 'Old fact.\n\nNew fact.');
    assert.equal(roadmap.extra, '## Other\n\nKeep me.');
  });

  test('warns when the notes outgrow the system prompt budget', async () => {
    const result = await update('x'.repeat(notesBudget + 1));

    assert.match(result, /more than fits in the system prompt/);
    assert.match(result, /replace set to true/);
  });

  test('does not warn when the notes fit exactly', async () => {
    const result = await update('x'.repeat(notesBudget));

    assert.doesNotMatch(result, /more than fits/);
  });
});
