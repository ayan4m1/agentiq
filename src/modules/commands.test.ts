import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// read when the config module first evaluates, so it has to be set before the
// dynamic import below - and it keeps the real commands out of these results
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-commands-'));

process.env.AQ_HOME = resolve(root, 'home');

const project = resolve(root, 'project');

mkdirSync(project, { recursive: true });
process.chdir(project);

const { commandsDir, expandCommand, loadCommands, projectCommandsDir } =
  await import('./commands');

const addCommand = (directory: string, file: string, content: string) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, file), content);
};

afterEach(() => {
  rmSync(commandsDir, { recursive: true, force: true });
  rmSync(projectCommandsDir(), { recursive: true, force: true });
});

describe('loading commands', () => {
  test('finds nothing when there are no commands directories', () => {
    assert.deepEqual(loadCommands(), []);
  });

  test('names a command for its file and reads its description', () => {
    addCommand(
      commandsDir,
      'review.md',
      '---\ndescription: Review the diff\n---\n\nReview $ARGUMENTS\n'
    );

    assert.deepEqual(loadCommands(), [
      {
        name: 'review',
        description: 'Review the diff',
        body: 'Review $ARGUMENTS',
        path: resolve(commandsDir, 'review.md')
      }
    ]);
  });

  test('takes a file with no frontmatter as all prompt', () => {
    addCommand(commandsDir, 'commit.md', 'Write a commit message\n');

    const [command] = loadCommands();

    assert.equal(command.description, undefined);
    assert.equal(command.body, 'Write a commit message');
  });

  test("lets the project's command replace a global one of the same name", () => {
    addCommand(commandsDir, 'review.md', 'global');
    addCommand(projectCommandsDir(), 'review.md', 'project');

    assert.deepEqual(
      loadCommands().map(({ body }) => body),
      ['project']
    );
  });

  test('lists commands from both directories in name order', () => {
    addCommand(projectCommandsDir(), 'test.md', 'Run the tests');
    addCommand(commandsDir, 'commit.md', 'Commit');
    addCommand(commandsDir, 'review.md', 'Review');

    assert.deepEqual(
      loadCommands().map(({ name }) => name),
      ['commit', 'review', 'test']
    );
  });

  test('leaves out a command named for a built-in one', () => {
    addCommand(commandsDir, 'help.md', 'Not the real help');
    addCommand(commandsDir, 'review.md', 'Review');

    assert.deepEqual(
      loadCommands(['help', 'quit']).map(({ name }) => name),
      ['review']
    );
  });

  test('leaves out files that are not markdown, empty, or untypeable', () => {
    addCommand(commandsDir, 'notes.txt', 'not a command');
    addCommand(commandsDir, 'empty.md', '---\ndescription: nothing\n---\n');
    addCommand(commandsDir, 'two words.md', 'cannot be typed');
    addCommand(commandsDir, 'review.md', 'Review');

    assert.deepEqual(
      loadCommands().map(({ name }) => name),
      ['review']
    );
  });

  test('takes empty frontmatter or a blank description as no description', () => {
    addCommand(commandsDir, 'blank.md', '---\ndescription: "  "\n---\nBlank');
    addCommand(commandsDir, 'empty.md', '---\n\n---\nEmpty');

    assert.deepEqual(
      loadCommands().map(({ name, description, body }) => ({
        name,
        description,
        body
      })),
      [
        { name: 'blank', description: undefined, body: 'Blank' },
        { name: 'empty', description: undefined, body: 'Empty' }
      ]
    );
  });

  test('carries on without a commands directory it cannot read', () => {
    // a file where the directory should be cannot be listed
    mkdirSync(resolve(commandsDir, '..'), { recursive: true });
    writeFileSync(commandsDir, 'not a directory');
    addCommand(projectCommandsDir(), 'review.md', 'Review');

    assert.deepEqual(
      loadCommands().map(({ name }) => name),
      ['review']
    );
  });

  test('skips a command whose frontmatter will not parse', () => {
    addCommand(commandsDir, 'broken.md', '---\n: : [\n---\nprompt');

    assert.deepEqual(loadCommands(), []);
  });

  test('picks up a command written since the last load', () => {
    assert.deepEqual(loadCommands(), []);

    addCommand(commandsDir, 'review.md', 'Review');

    assert.equal(loadCommands().length, 1);
  });
});

describe('expanding a command', () => {
  const command = (body: string) => ({ name: 'test', body, path: 'test.md' });

  test('puts everything typed in place of $ARGUMENTS', () => {
    assert.equal(
      expandCommand(command('Review $ARGUMENTS for bugs'), '  src/a.ts b.ts '),
      'Review src/a.ts b.ts for bugs'
    );
  });

  test('puts each word in place of its number', () => {
    assert.equal(
      expandCommand(command('Move $1 to $2, not $3'), 'a.ts b.ts'),
      'Move a.ts to b.ts, not '
    );
  });

  test('leaves $10 and beyond as they were written', () => {
    assert.equal(expandCommand(command('Costs $100'), ''), 'Costs $100');
  });

  test('adds arguments below a prompt with nowhere to put them', () => {
    assert.equal(
      expandCommand(command('Review the diff'), 'focus on errors'),
      'Review the diff\n\nfocus on errors'
    );
  });

  test('sends the prompt alone when nothing was typed after it', () => {
    assert.equal(expandCommand(command('Review $ARGUMENTS'), ''), 'Review ');
    assert.equal(expandCommand(command('Review')), 'Review');
  });

  test('keeps replacement patterns in what was typed as typed', () => {
    assert.equal(
      expandCommand(command('Say $ARGUMENTS'), "$& and $'"),
      "Say $& and $'"
    );
  });
});
