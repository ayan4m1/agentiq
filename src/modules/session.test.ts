import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Message } from 'ollama';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  utimesSync,
  writeFileSync
} from 'node:fs';

// both are read when the module under test first evaluates, so they have to be
// set before it is imported - which is why the import below is dynamic. node
// runs every test file in its own process, so this cannot leak into another
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-session-'));
const stateDir = resolve(root, 'state');
const sessionDir = resolve(stateDir, 'sessions');

process.env.AQ_HOME = stateDir;
process.env.AQ_SESSION_LIMIT = '2';

const {
  append,
  listSessions,
  loadSession,
  pruneSessions,
  rewrite,
  startSession
} = await import('./session');
const { slugFor } = await import('../utils');

const projectA = resolve(root, 'project-a');
const projectB = resolve(root, 'project-b');
const projectC = resolve(root, 'project-c');
const original = process.cwd();

const user = (content: string): Message => ({ role: 'user', content });

// the files this directory owns, by the same rule the module uses
const filesHere = () =>
  existsSync(sessionDir)
    ? readdirSync(sessionDir).filter((file) =>
        file.startsWith(`${slugFor(process.cwd())}_`)
      )
    : [];

const lines = (id: string) =>
  readFileSync(resolve(sessionDir, `${id}.jsonl`))
    .toString()
    .split('\n')
    .filter(Boolean);

before(() => {
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  mkdirSync(projectC, { recursive: true });
  process.chdir(projectA);
});

after(() => {
  process.chdir(original);
});

describe('slugFor', () => {
  test('replaces everything that is not alphanumeric', () => {
    assert.equal(slugFor('C:/code/agentiq'), 'C--code-agentiq');
  });

  test('replaces underscores too, so the id stays splittable', () => {
    // the slug is joined to a uuid with an underscore - one inside the slug
    // would make the two halves impossible to tell apart
    assert.ok(!slugFor('my_project').includes('_'));
  });
});

describe('startSession', () => {
  test('names the session after the working directory', () => {
    const id = startSession();

    assert.ok(id.startsWith(`${slugFor(process.cwd())}_`));
  });

  test('does not create a file until there is something to write', () => {
    const id = startSession();

    // a session that never went anywhere should not clutter the resume list
    assert.equal(existsSync(resolve(sessionDir, `${id}.jsonl`)), false);
  });
});

describe('append', () => {
  test('writes a meta record first, then a record per message', () => {
    const id = startSession();

    append([user('hello'), { role: 'assistant', content: 'hi' }]);

    const records = lines(id).map((line) => JSON.parse(line));

    assert.equal(records[0].type, 'meta');
    assert.equal(records[0].cwd, process.cwd());
    assert.equal(records.length, 3);
    assert.equal(records[1].message.content, 'hello');
  });

  test('leaves the system prompt out', () => {
    const id = startSession();

    append([{ role: 'system', content: 'rebuilt every run' }, user('hello')]);

    const records = lines(id).map((line) => JSON.parse(line));

    // the prompt is rebuilt from AGENTIQ.md on every run, so persisting it
    // would resume a stale copy
    assert.equal(records.length, 2);
    assert.equal(records[1].message.role, 'user');
  });

  test('writes each message only once across repeated calls', () => {
    const id = startSession();
    const messages = [user('one')];

    append(messages);
    messages.push(user('two'));
    append(messages);

    assert.equal(lines(id).length, 3);
  });
});

describe('loadSession', () => {
  test('round-trips what append wrote', () => {
    const id = startSession();

    append([user('remember this'), { role: 'assistant', content: 'noted' }]);

    const loaded = loadSession(id);

    assert.equal(loaded?.length, 2);
    assert.equal(loaded?.[0].content, 'remember this');
    assert.equal(loaded?.[1].role, 'assistant');
  });

  test('returns nothing for a session that is not there', () => {
    assert.equal(loadSession('nope'), undefined);
  });

  test('skips a line that will not parse rather than losing the file', () => {
    const id = startSession();
    // the same object on both calls: what has already been written is tracked
    // by identity, so a fresh object with equal content is a new message
    const before = user('before');

    append([before]);
    appendFileSync(resolve(sessionDir, `${id}.jsonl`), 'not json at all\n');
    append([before, user('after')]);

    const loaded = loadSession(id);

    assert.deepEqual(
      loaded?.map((message) => message.content),
      ['before', 'after']
    );
  });

  test('keeps writing to the same file after resuming it', () => {
    const id = startSession();

    append([user('first')]);

    // what the caller carries on with is what loadSession handed back, which
    // is how the run loop resumes a conversation
    const resumed = loadSession(id) ?? [];

    resumed.push(user('second'));
    append(resumed);

    // resuming twice must not scatter one conversation across three files
    assert.equal(lines(id).length, 3);
  });
});

describe('rewrite', () => {
  test('replaces the file with what survived compaction', () => {
    const id = startSession();

    append([user('one'), user('two'), user('three')]);
    rewrite([user('a summary of all that')]);

    const records = lines(id).map((line) => JSON.parse(line));

    assert.equal(records.length, 2);
    assert.equal(records[0].type, 'meta');
    assert.equal(records[1].message.content, 'a summary of all that');
  });
});

describe('listing and pruning per directory', () => {
  test('lists only the sessions belonging to this directory', () => {
    process.chdir(projectB);

    const mine = startSession();

    append([user('a conversation about project b')]);

    const listed = listSessions();

    assert.ok(listed.some((summary) => summary.id === mine));
    assert.ok(
      listed.every((summary) => summary.id.startsWith(`${slugFor(projectB)}_`))
    );
  });

  test('labels a session with its first user message', () => {
    process.chdir(projectB);
    startSession();
    append([user('the opening question')]);

    assert.equal(listSessions()[0].label, 'the opening question');
  });

  test('deletes the oldest beyond the limit, and nothing elsewhere', () => {
    // its own directory: the tests above left sessions in projectA, and with a
    // limit of two the count is what decides which files survive
    process.chdir(projectC);

    const ids: string[] = [];

    for (const n of [1, 2, 3]) {
      const id = startSession();

      append([user(`conversation ${n}`)]);
      ids.push(id);
    }

    // mtime is what decides which survive, and three files written in the same
    // millisecond would order arbitrarily
    ids.forEach((id, index) => {
      const when = new Date(Date.now() - (ids.length - index) * 60_000);

      utimesSync(resolve(sessionDir, `${id}.jsonl`), when, when);
    });

    process.chdir(projectB);

    const elsewhere = filesHere().length;

    process.chdir(projectC);
    pruneSessions();

    assert.equal(filesHere().length, 2, 'the limit is two');
    assert.equal(
      existsSync(resolve(sessionDir, `${ids[0]}.jsonl`)),
      false,
      'the oldest should be gone'
    );
    assert.ok(existsSync(resolve(sessionDir, `${ids[2]}.jsonl`)));

    process.chdir(projectB);

    // a busy project must not delete the history of one that has been quiet
    assert.equal(filesHere().length, elsewhere);
  });

  test('survives a directory it cannot read', () => {
    process.chdir(projectA);
    writeFileSync(resolve(sessionDir, 'not-a-session.txt'), 'ignore me');

    assert.doesNotThrow(() => listSessions());
  });
});
