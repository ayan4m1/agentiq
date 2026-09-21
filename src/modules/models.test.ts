import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ListResponse } from 'ollama';

// the store lives under the home directory, which is read as the config module
// is evaluated - so it has to point somewhere disposable before the imports
const home = mkdtempSync(resolve(tmpdir(), 'agentiq-models-'));

process.env.AQ_HOME = home;

// both prompts are answered by the test rather than the terminal, in the order
// they are asked. node's mockImplementationOnce is keyed to the call index the
// mock is on when it is queued, so two queued in a row would both answer the
// first prompt - answers are shifted off a list instead
let answers: (string | Error)[] = [];

const answer = async () => {
  const next = answers.shift();

  if (next instanceof Error) {
    throw next;
  }

  assert.ok(next !== undefined, 'the prompt asked more than the test answered');

  return next;
};

// select is handed what it was asked, so a test can assert on the choices it
// offered as well as on what came back
const select =
  mock.fn<(config: { choices: unknown[] }) => Promise<string>>(answer);
const input = mock.fn<(config: { message: string }) => Promise<string>>(answer);

mock.module('@inquirer/prompts', { namedExports: { select, input } });

// what the user types, in order. a prompt cancelled with ^C raises rather than
// resolving, so an Error stands for walking away from one
const typed = (...values: (string | Error)[]) => {
  answers = values;
};

const {
  applyEntry,
  chooseEntry,
  findEntry,
  loadStore,
  rememberEntry,
  resolveStartupEntry,
  saveStore,
  validateRepo
} = await import('./models');
const { ollama, tokenizer } = await import('./config');

const storePath = resolve(home, 'models.json');
const gemma = { model: 'gemma4:e4b', tokenizer: 'google/gemma-4-E4B' };
const qwen = {
  model: 'qwen3:30b',
  tokenizer: 'Qwen/Qwen3-Coder-30B-A3B-Instruct'
};

// only the call the chooser makes - show() is preflight's business
const server = (...names: string[]) => ({
  list: async () =>
    ({ models: names.map((name) => ({ name })) }) as ListResponse,
  show: async () => {
    throw new Error('not asked for here');
  }
});

// the store is rewritten by most of these, so each starts from nothing
beforeEach(() => {
  rmSync(storePath, { force: true });
  answers = [];
  select.mock.resetCalls();
  input.mock.resetCalls();
  ollama.model = '';
  tokenizer.repo = undefined;
});

describe('the saved store', () => {
  test('is empty before anything has been saved', () => {
    assert.deepEqual(loadStore(), { models: [] });
  });

  test('survives a round trip', () => {
    saveStore({ active: gemma.model, models: [gemma] });

    assert.deepEqual(loadStore(), { active: gemma.model, models: [gemma] });
  });

  test('reads as empty rather than throwing on a corrupt file', () => {
    writeFileSync(storePath, '{ this is not json');

    assert.deepEqual(loadStore(), { models: [] });
  });

  test('drops an entry that is missing half of the pair', () => {
    // a model with no tokenizer would silently fall back to estimating, which
    // is worse than never offering it as a choice
    writeFileSync(
      storePath,
      JSON.stringify({ models: [gemma, { model: 'orphan' }] })
    );

    assert.deepEqual(loadStore().models, [gemma]);
  });

  test('ignores an active name that no entry matches', () => {
    saveStore({ active: 'gone:latest', models: [gemma] });

    assert.equal(findEntry(loadStore(), loadStore().active), undefined);
  });
});

describe('remembering an entry', () => {
  test('saves it and makes it active', () => {
    rememberEntry(gemma);

    assert.deepEqual(loadStore(), { active: gemma.model, models: [gemma] });
  });

  test('keeps the entries that were already there', () => {
    rememberEntry(gemma);
    rememberEntry(qwen);

    const store = loadStore();

    assert.deepEqual(store.models, [gemma, qwen]);
    assert.equal(store.active, qwen.model);
  });

  test('replaces the tokenizer of a model already saved', () => {
    // re-adding a model is how a mismatched pair gets corrected, so the entry
    // has to be overwritten rather than duplicated
    rememberEntry(gemma);
    rememberEntry({ ...gemma, tokenizer: 'google/gemma-3-12b-it' });

    assert.deepEqual(loadStore().models, [
      { ...gemma, tokenizer: 'google/gemma-3-12b-it' }
    ]);
  });
});

describe('applying an entry', () => {
  test('moves both halves into the config', () => {
    applyEntry(qwen);

    assert.equal(ollama.model, qwen.model);
    assert.equal(tokenizer.repo, qwen.tokenizer);
  });
});

describe('validateRepo', () => {
  test('accepts an owner/name pair', () => {
    assert.equal(validateRepo('google/gemma-4-E4B'), true);
    assert.equal(validateRepo('  google/gemma-4-E4B  '), true);
  });

  test('refuses a blank answer', () => {
    // every saved entry has a tokenizer, so there is nothing to skip to
    assert.equal(typeof validateRepo(''), 'string');
    assert.equal(typeof validateRepo('   '), 'string');
  });

  test('refuses anything that is not a pair', () => {
    assert.equal(typeof validateRepo('gemma-4-E4B'), 'string');
    assert.equal(typeof validateRepo('google/gemma/extra'), 'string');
  });

  test('refuses a name that would climb out of the cache directory', () => {
    // the repo name is joined into a path under ~/.agentiq/tokenizers
    for (const repo of ['../../etc', '../evil', 'owner/..', '../..', './.']) {
      assert.equal(typeof validateRepo(repo), 'string', repo);
    }
  });
});

describe('choosing a model', () => {
  test('offers the saved entries and returns the one picked', async () => {
    saveStore({ active: gemma.model, models: [gemma, qwen] });
    typed(qwen.model);

    assert.deepEqual(await chooseEntry(server()), qwen);
    // the saved pairs plus the row that starts the add flow
    assert.equal(select.mock.calls[0].arguments[0].choices.length, 3);
  });

  test('goes straight to the add flow when nothing is saved', async () => {
    typed('gemma4:e4b', gemma.tokenizer);

    assert.deepEqual(await chooseEntry(server('gemma4:e4b')), gemma);
    // the installed model plus the manual-entry row - no list of saved pairs
    assert.equal(select.mock.calls[0].arguments[0].choices.length, 2);
  });

  test('takes a model name that is not installed yet', async () => {
    // the empty value is the manual-entry row, which asks for a name
    typed('', '  not-pulled-yet  ', qwen.tokenizer);

    assert.deepEqual(await chooseEntry(server('gemma4:e4b')), {
      model: 'not-pulled-yet',
      tokenizer: qwen.tokenizer
    });
  });

  test('saves nothing of its own', async () => {
    typed('gemma4:e4b', gemma.tokenizer);

    await chooseEntry(server('gemma4:e4b'));

    // remembering is the caller's decision - a switch that preflight then
    // refuses must not have rewritten the store on the way
    assert.deepEqual(loadStore(), { models: [] });
  });

  test('reaches the add flow from the saved list', async () => {
    saveStore({ active: gemma.model, models: [gemma] });
    // the empty value is the "Add a new model…" row
    typed('', qwen.model, qwen.tokenizer);

    assert.deepEqual(await chooseEntry(server(qwen.model)), qwen);
  });

  test('gives nothing back when the prompt is cancelled', async () => {
    saveStore({ models: [gemma] });
    typed(new Error('User force closed the prompt'));

    assert.equal(await chooseEntry(server()), undefined);
  });

  test('gives nothing back when the server cannot be reached', async () => {
    const unreachable = {
      list: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      show: async () => {
        throw new Error('not asked for here');
      }
    };

    assert.equal(await chooseEntry(unreachable), undefined);
  });
});

describe('resolving the model to start on', () => {
  test('applies the active entry without asking', async () => {
    saveStore({ active: qwen.model, models: [gemma, qwen] });

    assert.equal(await resolveStartupEntry(server()), true);
    assert.equal(ollama.model, qwen.model);
    assert.equal(tokenizer.repo, qwen.tokenizer);
    assert.equal(select.mock.callCount(), 0);
  });

  test('falls back to the first saved entry when none is active', async () => {
    // a hand-edited file may have no active name at all
    saveStore({ models: [gemma] });

    assert.equal(await resolveStartupEntry(server()), true);
    assert.equal(ollama.model, gemma.model);
  });

  test('asks and saves the answer on a first run', async () => {
    typed('gemma4:e4b', gemma.tokenizer);

    assert.equal(await resolveStartupEntry(server('gemma4:e4b')), true);
    assert.equal(ollama.model, gemma.model);
    assert.deepEqual(loadStore(), { active: gemma.model, models: [gemma] });
  });

  test('refuses to start when the question goes unanswered', async () => {
    typed(new Error('User force closed the prompt'));

    assert.equal(await resolveStartupEntry(server('gemma4:e4b')), false);
    assert.equal(ollama.model, '');
  });
});
