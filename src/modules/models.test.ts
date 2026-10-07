import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

import { fakePrompts } from '../../test/fakes/inquirer';
import type { ModuleMock } from '../../test/fakes/module';
import type { ModelEntry, ModelStore } from '../types';

// the store lives under the home directory, which is read as the config module
// is evaluated - so it has to point somewhere disposable before the imports
const home = mkdtempSync(resolve(tmpdir(), 'agentiq-models-'));

process.env.AQ_HOME = home;

// both prompts are answered by the test rather than the terminal, in the order
// they are asked. node's mockImplementationOnce is keyed to the call index the
// mock is on when it is queued, so two queued in a row would both answer the
// first prompt - answers are shifted off a list instead
let answers: (string | boolean | Error)[] = [];

const answer = async () => {
  const next = answers.shift();

  if (next instanceof Error) {
    throw next;
  }

  assert.ok(next !== undefined, 'the prompt asked more than the test answered');

  return next as never;
};

// select is handed what it was asked, so a test can assert on the choices it
// offered as well as on what came back
const select =
  mock.fn<(config: { choices: readonly unknown[] }) => Promise<string>>(answer);
const input = mock.fn<(config: { message: string }) => Promise<string>>(answer);
const confirm =
  mock.fn<(config: { message: string }) => Promise<boolean>>(answer);

// the saved list is a prompt of our own, answered from the same queue. what it
// was handed is kept for the test to look at, remove callback included
type Picked = {
  choices: { value: string; missing?: boolean; locked?: string }[];
  remove: (value: string) => void;
};

const pickModel =
  mock.fn<(config: Picked) => Promise<string | undefined>>(answer);

mock.module('@inquirer/prompts', {
  exports: fakePrompts({ select, input, confirm }).exports
});
mock.module('./picker', {
  exports: { pickModel } satisfies ModuleMock<typeof import('./picker')>
});

// what the user types, in order. a prompt cancelled with ^C raises rather than
// resolving, so an Error stands for walking away from one
const typed = (...values: (string | boolean | Error)[]) => {
  answers = values;
};

const {
  activeModel,
  applyEntry,
  chooseEntry,
  clearModels,
  findEntry,
  findTyped,
  forgetEntry,
  loadStore,
  markActive,
  rememberEntry,
  resolveStartupEntry,
  saveStore,
  savedModels,
  validateRepo
} = await import('./models');
const { provider, tokenizer } = await import('./config');
const { terminal } = await import('./turn');
const { Provider } = await import('../types');

const storePath = resolve(home, 'models.yml');
const legacyPath = resolve(home, 'models.json');
const gemma = { model: 'gemma4:e4b', tokenizer: 'google/gemma-4-E4B' };
const qwen = {
  model: 'qwen3:30b',
  tokenizer: 'Qwen/Qwen3-Coder-30B-A3B-Instruct'
};
const claude = { model: 'claude-opus-5' };

// a store holding these models under one provider - the configured one unless
// told otherwise - and nothing under any other
const stored = (
  models: ModelEntry[],
  active?: string,
  name: keyof ModelStore['models'] = provider.name
): ModelStore => ({
  active: active ? { [name]: active } : {},
  models: { [name]: models }
});

// only the call the chooser makes - describeModel() is preflight's business
const server = (...names: string[]) => ({
  label: 'the test server',
  listModels: async () => names.map((name) => ({ name, id: name })),
  describeModel: async () => {
    throw new Error('not asked for here');
  }
});

const unreachable = {
  label: 'the test server',
  listModels: async () => {
    throw new Error('connect ECONNREFUSED');
  },
  describeModel: async () => {
    throw new Error('not asked for here');
  }
};

// the store is rewritten by most of these, so each starts from nothing
beforeEach(() => {
  rmSync(storePath, { force: true });
  rmSync(legacyPath, { force: true });
  answers = [];
  select.mock.resetCalls();
  input.mock.resetCalls();
  confirm.mock.resetCalls();
  pickModel.mock.resetCalls();
  provider.name = Provider.Ollama;
  provider.model = '';
  tokenizer.repo = undefined;
  terminal.interactive = true;
});

describe('the saved store', () => {
  test('is empty before anything has been saved', () => {
    assert.deepEqual(loadStore(), { active: {}, models: {} });
  });

  test('survives a round trip', () => {
    saveStore(stored([gemma], gemma.model));

    assert.deepEqual(loadStore(), stored([gemma], gemma.model));
  });

  test('reads as empty rather than throwing on a corrupt file', () => {
    writeFileSync(storePath, 'models: [unclosed\n');

    assert.deepEqual(loadStore(), { active: {}, models: {} });
  });

  test('keeps an entry with no tokenizer', () => {
    // it runs on the estimate until the server reports what it counted
    writeFileSync(storePath, stringify(stored([gemma, { model: 'orphan' }])));

    assert.deepEqual(savedModels(loadStore()), [gemma, { model: 'orphan' }]);
  });

  test('drops an entry whose tokenizer names nothing', () => {
    writeFileSync(
      storePath,
      stringify(
        stored([
          gemma,
          { model: 'blank', tokenizer: '' },
          { model: 'numeric', tokenizer: 42 as unknown as string }
        ])
      )
    );

    assert.deepEqual(savedModels(loadStore()), [gemma]);
  });

  test('reads a file from before models were kept per provider as empty', () => {
    writeFileSync(
      storePath,
      stringify({ active: gemma.model, models: [gemma, qwen] })
    );

    assert.deepEqual(loadStore(), { active: {}, models: {} });
  });

  test('moves a models.json from an older version into models.yml', () => {
    // its flat list predates every provider but ollama, whichever one is
    // configured when it is found
    provider.name = Provider.Anthropic;
    writeFileSync(
      legacyPath,
      JSON.stringify({ active: gemma.model, models: [gemma, qwen] })
    );

    const moved = {
      active: { ollama: gemma.model },
      models: { ollama: [gemma, qwen] }
    };

    assert.deepEqual(loadStore(), moved);
    assert.equal(existsSync(legacyPath), false);
    assert.deepEqual(parse(readFileSync(storePath, 'utf8')), moved);
  });

  test('leaves a models.json alone once models.yml exists', () => {
    saveStore(stored([gemma], gemma.model));
    writeFileSync(legacyPath, JSON.stringify({ models: [qwen] }));

    assert.deepEqual(loadStore(), stored([gemma], gemma.model));
    assert.equal(existsSync(legacyPath), true);
  });

  test('ignores an active name that no entry matches', () => {
    saveStore(stored([gemma], 'gone:latest'));

    assert.equal(findEntry(loadStore(), activeModel(loadStore())), undefined);
  });
});

describe('remembering an entry', () => {
  test('saves it and makes it active', () => {
    rememberEntry(gemma);

    assert.deepEqual(loadStore(), stored([gemma], gemma.model));
  });

  test('keeps the entries that were already there', () => {
    rememberEntry(gemma);
    rememberEntry(qwen);

    const store = loadStore();

    assert.deepEqual(savedModels(store), [gemma, qwen]);
    assert.equal(activeModel(store), qwen.model);
  });

  test('replaces the tokenizer of a model already saved', () => {
    // re-adding a model is how a mismatched pair gets corrected, so the entry
    // has to be overwritten rather than duplicated
    rememberEntry(gemma);
    rememberEntry({ ...gemma, tokenizer: 'google/gemma-3-12b-it' });

    assert.deepEqual(savedModels(loadStore()), [
      { ...gemma, tokenizer: 'google/gemma-3-12b-it' }
    ]);
  });
});

describe('forgetting an entry', () => {
  test('removes it and keeps the rest', () => {
    saveStore(stored([gemma, qwen], gemma.model));
    forgetEntry(qwen.model);

    assert.deepEqual(loadStore(), stored([gemma], gemma.model));
  });

  test('clears the active name when it pointed at the entry', () => {
    saveStore(stored([gemma, qwen], qwen.model));
    forgetEntry(qwen.model);

    assert.equal(activeModel(loadStore()), undefined);
    assert.deepEqual(savedModels(loadStore()), [gemma]);
  });
});

describe('models kept per provider', () => {
  // gemma saved for ollama, claude for anthropic, each the one to start on
  const both = (): ModelStore => ({
    active: { ollama: gemma.model, anthropic: claude.model },
    models: { ollama: [gemma], anthropic: [claude] }
  });

  // this also keeps anthropic's entries, which have no tokenizer - checked
  // against ollama's rule, claude would be dropped and then lost on the next
  // save
  test('remembers under the configured provider alone', () => {
    saveStore(both());
    rememberEntry(qwen);

    assert.deepEqual(loadStore(), {
      active: { ollama: qwen.model, anthropic: claude.model },
      models: { ollama: [gemma, qwen], anthropic: [claude] }
    });
  });

  test('forgets under the configured provider alone', () => {
    saveStore(both());
    provider.name = Provider.Anthropic;
    forgetEntry(claude.model);

    assert.deepEqual(loadStore(), {
      active: { ollama: gemma.model },
      models: { ollama: [gemma], anthropic: [] }
    });
  });

  test('marks the active model under the configured provider alone', () => {
    saveStore(both());
    markActive('other:latest');

    assert.deepEqual(loadStore().active, {
      ollama: 'other:latest',
      anthropic: claude.model
    });
  });

  test('offers only the configured provider’s models', async () => {
    saveStore(both());
    provider.name = Provider.Anthropic;
    typed(claude.model);

    await chooseEntry(server(claude.model));

    assert.deepEqual(
      pickModel.mock.calls[0].arguments[0].choices.map(({ value }) => value),
      [claude.model, '']
    );
  });

  test('starts on the configured provider’s active model', async () => {
    saveStore(both());
    provider.name = Provider.Anthropic;

    assert.equal(await resolveStartupEntry(server(claude.model)), true);
    assert.equal(provider.model, claude.model);
  });

  test('asks on a first run under a provider with nothing saved', async () => {
    // models saved for ollama are no use to anthropic
    saveStore(stored([gemma], gemma.model, Provider.Ollama));
    provider.name = Provider.Anthropic;
    typed(claude.model);

    assert.equal(await resolveStartupEntry(server(claude.model)), true);
    assert.equal(provider.model, claude.model);
  });
});

describe('clearing the models', () => {
  test('empties the configured provider alone', () => {
    saveStore({
      active: { ollama: gemma.model, anthropic: claude.model },
      models: { ollama: [gemma, qwen], anthropic: [claude] }
    });
    clearModels();

    assert.deepEqual(loadStore(), {
      active: { anthropic: claude.model },
      models: { ollama: [], anthropic: [claude] }
    });
  });
});

describe('applying an entry', () => {
  test('moves both halves into the config', () => {
    applyEntry(qwen);

    assert.equal(provider.model, qwen.model);
    assert.equal(tokenizer.repo, qwen.tokenizer);
  });
});

describe('finding a typed name', () => {
  const llama = { model: 'llama3:latest' };

  test('finds the entry saved under that name', () => {
    assert.deepEqual(findTyped(stored([gemma, qwen]), qwen.model), qwen);
  });

  test('finds the :latest entry for a bare name', () => {
    assert.deepEqual(findTyped(stored([gemma, llama]), 'llama3'), llama);
  });

  test('prefers an entry saved under exactly that name', () => {
    const bare = { model: 'llama3' };

    assert.deepEqual(findTyped(stored([llama, bare]), 'llama3'), bare);
  });

  test('does not take one tag for another', () => {
    assert.equal(findTyped(stored([gemma]), 'gemma4:2b'), undefined);
  });

  test('looks only at the configured provider', () => {
    assert.equal(
      findTyped(stored([gemma], undefined, Provider.Anthropic), gemma.model),
      undefined
    );
  });

  test('finds nothing in an empty store', () => {
    assert.equal(findTyped(loadStore(), gemma.model), undefined);
  });
});

describe('validateRepo', () => {
  test('accepts an owner/name pair', () => {
    assert.equal(validateRepo('google/gemma-4-E4B'), true);
    assert.equal(validateRepo('  google/gemma-4-E4B  '), true);
  });

  test('accepts a blank answer', () => {
    // no tokenizer at all, which leaves the context to the estimate
    assert.equal(validateRepo(''), true);
    assert.equal(validateRepo('   '), true);
  });

  test('refuses anything that is not a pair', () => {
    assert.equal(typeof validateRepo('gemma-4-E4B'), 'string');
    assert.equal(typeof validateRepo('google/gemma/extra'), 'string');
  });

  test('accepts a local directory that exists', () => {
    mkdirSync(resolve(home, 'my-tokenizer'), { recursive: true });

    assert.equal(validateRepo('./my-tokenizer'), true);
    assert.equal(validateRepo(resolve(home, 'my-tokenizer')), true);
  });

  test('refuses a local directory that does not exist', () => {
    assert.equal(typeof validateRepo('./missing'), 'string');
    assert.equal(typeof validateRepo(resolve(home, 'missing')), 'string');
  });

  test('refuses a name that would climb out of the cache directory', () => {
    // the repo name is joined into a path under ~/.agentiq/tokenizers. one that
    // names an existing directory is taken as a local tokenizer instead, which
    // is only ever read - so these are all spelled to miss
    for (const repo of [
      '../../missing',
      '../evil',
      'owner/..',
      '../../..missing',
      './.missing'
    ]) {
      assert.equal(typeof validateRepo(repo), 'string', repo);
    }
  });
});

describe('choosing a model', () => {
  test('offers the saved entries and returns the one picked', async () => {
    saveStore(stored([gemma, qwen], gemma.model));
    typed(qwen.model);

    assert.deepEqual(await chooseEntry(server()), qwen);
    // the saved pairs plus the row that starts the add flow
    assert.equal(pickModel.mock.calls[0].arguments[0].choices.length, 3);
  });

  test('marks the saved models the server does not have', async () => {
    saveStore(stored([gemma, qwen, { ...gemma, model: 'bare' }]));
    typed(gemma.model);

    // a bare name is the same model as its :latest tag
    await chooseEntry(server(gemma.model, 'bare:latest'));

    assert.deepEqual(
      pickModel.mock.calls[0].arguments[0].choices.map(({ missing }) =>
        Boolean(missing)
      ),
      [false, true, false, false]
    );
  });

  test('marks nothing when the server cannot be reached', async () => {
    saveStore(stored([gemma, qwen]));
    typed(gemma.model);

    assert.deepEqual(await chooseEntry(unreachable), gemma);
    assert.ok(
      pickModel.mock.calls[0].arguments[0].choices.every(
        ({ missing }) => !missing
      )
    );
  });

  test('will not remove the model in use or the add row', async () => {
    saveStore(stored([gemma, qwen]));
    provider.model = gemma.model;
    typed(qwen.model);

    await chooseEntry(server());

    assert.deepEqual(
      pickModel.mock.calls[0].arguments[0].choices.map(({ locked }) =>
        Boolean(locked)
      ),
      [true, false, true]
    );
  });

  test('removes a pair from the store as soon as the user confirms', async () => {
    saveStore(stored([gemma, qwen], gemma.model));
    pickModel.mock.mockImplementationOnce(async ({ remove }) => {
      remove(qwen.model);

      throw new Error('User force closed the prompt');
    });

    // walking away afterwards does not bring it back
    assert.equal(await chooseEntry(server()), undefined);
    assert.deepEqual(loadStore(), stored([gemma], gemma.model));
  });

  test('returns nothing when the picker is escaped', async () => {
    saveStore(stored([gemma, qwen], gemma.model));
    pickModel.mock.mockImplementationOnce(async () => undefined);

    assert.equal(await chooseEntry(server()), undefined);
    assert.equal(select.mock.callCount(), 0);
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
    assert.deepEqual(loadStore(), { active: {}, models: {} });
  });

  test('reaches the add flow from the saved list', async () => {
    saveStore(stored([gemma], gemma.model));
    // the empty value is the "Add a new model…" row
    typed('', qwen.model, qwen.tokenizer);

    assert.deepEqual(await chooseEntry(server(qwen.model)), qwen);
  });

  test('gives nothing back when the prompt is cancelled', async () => {
    saveStore(stored([gemma]));
    typed(new Error('User force closed the prompt'));

    assert.equal(await chooseEntry(server()), undefined);
  });

  test('gives nothing back when the server cannot be reached', async () => {
    assert.equal(await chooseEntry(unreachable), undefined);
  });
});

describe('resolving the model to start on', () => {
  test('applies the active entry without asking', async () => {
    saveStore(stored([gemma, qwen], qwen.model));

    assert.equal(await resolveStartupEntry(server(qwen.model)), true);
    assert.equal(provider.model, qwen.model);
    assert.equal(tokenizer.repo, qwen.tokenizer);
    assert.equal(select.mock.callCount(), 0);
  });

  test('falls back to the first saved entry when none is active', async () => {
    // a hand-edited file may have no active name at all
    saveStore(stored([gemma]));

    assert.equal(await resolveStartupEntry(server(gemma.model)), true);
    assert.equal(provider.model, gemma.model);
  });

  test('asks and saves the answer on a first run', async () => {
    typed('gemma4:e4b', gemma.tokenizer);

    assert.equal(await resolveStartupEntry(server('gemma4:e4b')), true);
    assert.equal(provider.model, gemma.model);
    assert.deepEqual(loadStore(), stored([gemma], gemma.model));
  });

  test('saves a model with no tokenizer when the question is skipped', async () => {
    typed('gemma4:e4b', '   ');

    assert.equal(await resolveStartupEntry(server('gemma4:e4b')), true);
    assert.equal(provider.model, gemma.model);
    assert.equal(tokenizer.repo, undefined);
    // no tokenizer key at all, rather than one loadStore would refuse
    assert.deepEqual(
      loadStore(),
      stored([{ model: gemma.model }], gemma.model)
    );
  });

  test('refuses to start when the question goes unanswered', async () => {
    typed(new Error('User force closed the prompt'));

    assert.equal(await resolveStartupEntry(server('gemma4:e4b')), false);
    assert.equal(provider.model, '');
  });

  test('refuses to start without asking when there is no terminal', async () => {
    terminal.interactive = false;

    assert.equal(await resolveStartupEntry(server('gemma4:e4b')), false);
    assert.equal(provider.model, '');
    assert.equal(select.mock.callCount(), 0);
    assert.equal(input.mock.callCount(), 0);
  });

  test('applies a saved entry when there is no terminal', async () => {
    // even one the server lacks - there is nobody to ask, so preflight says so
    terminal.interactive = false;
    saveStore(stored([gemma], gemma.model));

    assert.equal(await resolveStartupEntry(server()), true);
    assert.equal(provider.model, gemma.model);
    assert.equal(confirm.mock.callCount(), 0);
  });

  test('refuses to start without asking when the server cannot be reached', async () => {
    saveStore(stored([gemma], gemma.model));

    assert.equal(await resolveStartupEntry(unreachable), false);
    assert.equal(provider.model, '');
    assert.equal(confirm.mock.callCount(), 0);
  });

  test('keeps the store and refuses to start when told not to clear it', async () => {
    saveStore(stored([gemma, qwen], gemma.model));
    typed(false);

    assert.equal(await resolveStartupEntry(server(qwen.model)), false);
    assert.equal(provider.model, '');
    assert.deepEqual(loadStore(), stored([gemma, qwen], gemma.model));
  });

  test('treats a cancelled question as a no', async () => {
    saveStore(stored([gemma], gemma.model));
    typed(new Error('User force closed the prompt'));

    assert.equal(await resolveStartupEntry(server(qwen.model)), false);
    assert.deepEqual(loadStore(), stored([gemma], gemma.model));
  });

  test('clears the store and asks again when the active model is gone', async () => {
    saveStore({
      active: { ollama: 'gone:latest', anthropic: claude.model },
      models: {
        ollama: [{ ...gemma, model: 'gone:latest' }, qwen],
        anthropic: [claude]
      }
    });
    typed(true, gemma.model, gemma.tokenizer);

    assert.equal(await resolveStartupEntry(server(gemma.model)), true);
    assert.equal(provider.model, gemma.model);
    assert.deepEqual(loadStore(), {
      active: { anthropic: claude.model, ollama: gemma.model },
      models: { ollama: [gemma], anthropic: [claude] }
    });
  });
});

// neither is paired with a tokenizer - anthropic counts for itself, and openai
// is corrected from the usage its server reports
for (const name of [Provider.Anthropic, Provider.OpenAI]) {
  describe(`a provider with no tokenizer (${name})`, () => {
    beforeEach(() => {
      provider.name = name;
    });

    test('keeps an entry with no tokenizer', () => {
      writeFileSync(storePath, stringify(stored([claude])));

      assert.deepEqual(savedModels(loadStore()), [claude]);
    });

    test('never asks for a tokenizer', async () => {
      typed(claude.model);

      assert.deepEqual(await chooseEntry(server(claude.model)), claude);
      assert.equal(input.mock.callCount(), 0);
    });

    test('lists a saved entry by its name alone', async () => {
      saveStore(stored([claude], claude.model));
      typed(claude.model);

      await chooseEntry(server(claude.model));

      assert.deepEqual(
        pickModel.mock.calls[0].arguments[0].choices.map(
          (choice) => (choice as { name?: string }).name
        )[0],
        claude.model
      );
    });

    test('clears any tokenizer left by the last entry', () => {
      tokenizer.repo = gemma.tokenizer;
      applyEntry(claude);

      assert.equal(tokenizer.repo, undefined);
    });
  });
}
