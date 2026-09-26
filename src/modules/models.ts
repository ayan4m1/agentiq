import chalk from 'chalk';
import { resolve } from 'node:path';
import { input, select } from '@inquirer/prompts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { getLogger } from './logging';
import { terminal } from './turn';
import { pickModel } from './picker';
import { type Api, listModels, matchesModel } from './preflight';
import { home, ollama, tokenizer } from './config';
import type { ModelEntry, ModelStore } from '../types';
import { describeError } from '../utils';

const log = getLogger('models');
// alongside sessions/ and tokenizers/, which already live under the same root
const storePath = resolve(home, 'models.json');
// the same shape modules/tokenizer.ts insists on before it joins the name into
// a cache path - checked here as well so a bad one is caught while the user is
// still looking at the prompt that produced it
// neither half may be dots alone, which the character class would otherwise
// let through as a `..` segment
const repoPattern = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;

// the "none of the above" row in either list. it is compared against a model
// name, which can never be empty, so it cannot collide with a real choice
const other = '';

// what the prompt will accept as a huggingface repo. returns true or the reason
// it does not, which is what @inquirer/prompts wants from a validator
export const validateRepo = (value: string) => {
  const spelled = value.trim();

  if (!spelled) {
    return 'A tokenizer repository is required';
  }

  return (
    repoPattern.test(spelled) ||
    'Expected an owner/name pair, e.g. google/gemma-4-E4B'
  );
};

// an entry is only useful with both halves, so a half-written one is dropped
// rather than carried into the session as a model with no tokenizer
const readable = (value: unknown): value is ModelEntry => {
  const entry = value as ModelEntry;

  return Boolean(
    entry &&
    typeof entry.model === 'string' &&
    entry.model &&
    typeof entry.tokenizer === 'string' &&
    entry.tokenizer
  );
};

// a file that cannot be read is an empty store rather than a failure to start:
// the user is about to be asked which model to use anyway, and answering is a
// better way out than an error they have to go and edit JSON to clear
export const loadStore = (): ModelStore => {
  if (!existsSync(storePath)) {
    return { models: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath).toString());
    const models = Array.isArray(parsed?.models)
      ? parsed.models.filter(readable)
      : [];

    if (Array.isArray(parsed?.models) && models.length < parsed.models.length) {
      log.warn(`Ignoring incomplete entries in ${storePath}`);
    }

    return {
      active: typeof parsed?.active === 'string' ? parsed.active : undefined,
      models
    };
  } catch (error) {
    log.warn(`Could not read ${storePath}: ${describeError(error)}`);

    return { models: [] };
  }
};

export const saveStore = (store: ModelStore) => {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
  } catch (error) {
    // the session can still run on the entry that was chosen - it just will not
    // be there next time, which is worth saying but not worth stopping for
    log.warn(`Could not write ${storePath}: ${describeError(error)}`);
  }
};

export const findEntry = (store: ModelStore, model?: string) =>
  store.models.find((entry) => entry.model === model);

// the only writer of these two settings. every consumer reads them at call time
// - preflight before a turn, the tokenizer when it builds a cache path - so
// there is nothing else to notify
export const applyEntry = (entry: ModelEntry) => {
  ollama.model = entry.model;
  tokenizer.repo = entry.tokenizer;
};

// upsert by model name: choosing a model that is already saved with a different
// tokenizer is how a mismatched pair gets corrected, so the new one wins
export const rememberEntry = (entry: ModelEntry) => {
  const store = loadStore();
  const models = store.models.filter(({ model }) => model !== entry.model);

  models.push(entry);
  saveStore({ active: entry.model, models });

  return entry;
};

// the other half of rememberEntry. an active name left pointing at nothing
// would be ignored on the next start anyway, but it is cleared rather than left
// for a hand-edit to trip over
export const forgetEntry = (model: string) => {
  const store = loadStore();

  saveStore({
    active: store.active === model ? undefined : store.active,
    models: store.models.filter((entry) => entry.model !== model)
  });
};

// the user walked away from the prompt - ^C raises rather than resolves, and
// that is an answer of its own everywhere this is called
const cancelled = (error: unknown) => {
  log.debug(`Model selection was cancelled: ${describeError(error)}`);

  return undefined;
};

// the add flow: a name from the server, or one typed in for a model that is
// about to be pulled, plus the repo whose tokenizer matches it. the caller may
// already have asked the server, and there is no need to ask twice
const addEntry = async (
  api?: Api,
  known?: Awaited<ReturnType<typeof listModels>>
): Promise<ModelEntry | undefined> => {
  const installed = known ?? (await listModels(api));

  if (!installed) {
    return;
  }

  const names = installed
    .map((model) => model.name ?? model.model)
    .filter(Boolean);

  try {
    let model = await select({
      message: 'Which ollama model?',
      choices: [
        ...names.map((name) => ({ name, value: name })),
        { name: 'Enter a name manually…', value: other }
      ]
    });

    if (model === other) {
      model = (
        await input({
          message: 'Model name',
          validate: (value) => Boolean(value.trim()) || 'A name is required'
        })
      ).trim();
    }

    const repo = await input({
      message: 'Which huggingface.co repo has its tokenizer?',
      validate: validateRepo
    });

    return { model, tokenizer: repo.trim() };
  } catch (error) {
    return cancelled(error);
  }
};

// pick one of the saved pairs, or set up a new one. the caller decides what to
// do with it - this neither saves nor applies anything, except that a pair the
// user removes from the list is gone from the store as soon as they say so
export const chooseEntry = async (
  api?: Api
): Promise<ModelEntry | undefined> => {
  const store = loadStore();

  if (!store.models.length) {
    return addEntry(api);
  }

  const installed = await listModels(api);

  // nothing is marked when the server could not be asked - listModels has
  // already said so, and a list of every model in red would say nothing more
  const names = (installed ?? [])
    .flatMap((model) => [model.name, model.model])
    .filter(Boolean);
  const isMissing = (model: string) =>
    Boolean(installed) && !names.some((name) => matchesModel(name, model));

  let model;

  try {
    model = await pickModel({
      message: 'Which model?',
      choices: [
        ...store.models.map((entry) => ({
          name: `${entry.model} ${chalk.gray(`(${entry.tokenizer})`)}`,
          value: entry.model,
          missing: isMissing(entry.model),
          // switchModel falls back to this entry when a switch fails, so it
          // has to still be there
          locked:
            entry.model === ollama.model
              ? `${entry.model} is in use and cannot be removed`
              : undefined
        })),
        {
          name: 'Add a new model…',
          value: other,
          locked: 'Only a saved model can be removed'
        }
      ],
      default: store.active,
      remove: forgetEntry
    });
  } catch (error) {
    return cancelled(error);
  }

  if (model === undefined) {
    return cancelled('escape was pressed');
  }

  return model === other
    ? addEntry(api, installed)
    : findEntry(loadStore(), model);
};

// run before preflight: nothing else works until the config knows which model
// it is talking about. a store with an active entry starts without a prompt,
// which is the ordinary case - the question is only asked on a fresh install
export const resolveStartupEntry = async (api?: Api) => {
  const store = loadStore();
  const active = findEntry(store, store.active) ?? store.models[0];

  if (active) {
    applyEntry(active);

    return true;
  }

  // exec has nobody to answer the questions that would set one up
  if (!terminal.interactive) {
    log.error(
      chalk.red(
        'No model has been set up - run `agentiq run` once to choose one'
      )
    );

    return false;
  }

  log.info(chalk.green('No model has been set up yet'));

  const chosen = await addEntry(api);

  if (!chosen) {
    return false;
  }

  applyEntry(rememberEntry(chosen));

  return true;
};
