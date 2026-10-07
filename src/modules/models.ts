import chalk from 'chalk';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { confirm, input, select } from '@inquirer/prompts';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

import { getLogger } from './logging';
import { terminal } from './turn';
import { pickModel } from './picker';
import { localTokenizerDir, usesHfTokenizer } from './tokenizer';
import {
  type PreflightApi,
  isInstalled,
  listModels,
  matchesModel
} from './preflight';
import { home, provider, tokenizer } from './config';
import { chatProvider } from '../providers';
import { type ModelEntry, type ModelStore, Provider } from '../types';
import { describeError } from '../utils';

const log = getLogger('models');
// alongside sessions/ and tokenizers/, which already live under the same root
const storePath = resolve(home, 'models.yml');
// where the store was kept before it moved to yaml
const legacyPath = resolve(home, 'models.json');
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

  // no tokenizer at all is a choice: the context is estimated until the
  // server reports what it counted, as it does for every other provider
  if (!spelled) {
    return true;
  }

  return (
    repoPattern.test(spelled) ||
    Boolean(localTokenizerDir(spelled)) ||
    'Expected an owner/name pair, e.g. google/gemma-4-E4B, or a directory such as ./my-tokenizer'
  );
};

// the tokenizer is optional - an entry without one runs on the estimate until
// the server reports what it counted - but one that is there has to name
// something, or it would be carried into the session as a repo of ''
const readable = (value: unknown): value is ModelEntry => {
  const entry = value as ModelEntry;

  return Boolean(
    entry &&
    typeof entry.model === 'string' &&
    entry.model &&
    (entry.tokenizer === undefined ||
      (typeof entry.tokenizer === 'string' && entry.tokenizer))
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const emptyStore = (): ModelStore => ({ active: {}, models: {} });

// a models.json left by an older version is rewritten as models.yml and then
// removed. json is valid yaml, so the same parser reads it. its one flat list
// predates every provider but ollama, so that is where its entries are filed.
// the old file is only deleted once the new one has been written, so a failure
// loses nothing - and loadStore checks the entries as it would any others
const migrateLegacyStore = () => {
  if (existsSync(storePath) || !existsSync(legacyPath)) {
    return;
  }

  try {
    const parsed: unknown = parse(readFileSync(legacyPath, 'utf8'));
    const store = emptyStore();

    if (isRecord(parsed) && Array.isArray(parsed.models)) {
      store.models[Provider.Ollama] = parsed.models;
    }

    if (isRecord(parsed) && typeof parsed.active === 'string') {
      store.active[Provider.Ollama] = parsed.active;
    }

    writeFileSync(storePath, stringify(store));
    rmSync(legacyPath);
    log.info(`Moved ${legacyPath} to ${storePath}`);
  } catch (error) {
    log.warn(`Could not move ${legacyPath}: ${describeError(error)}`);
  }
};

// a file that cannot be read is an empty store rather than a failure to start:
// the user is about to be asked which model to use anyway, and answering is a
// better way out than an error they have to go and edit YAML to clear. that
// includes a file from before models were kept per provider
export const loadStore = (): ModelStore => {
  migrateLegacyStore();

  if (!existsSync(storePath)) {
    return emptyStore();
  }

  try {
    const parsed: unknown = parse(readFileSync(storePath, 'utf8'));
    const store = emptyStore();

    if (!isRecord(parsed) || !isRecord(parsed.models)) {
      return store;
    }

    for (const [name, list] of Object.entries(parsed.models)) {
      if (!Array.isArray(list)) {
        continue;
      }

      const models = list.filter(readable);

      if (models.length < list.length) {
        log.warn(`Ignoring incomplete ${name} entries in ${storePath}`);
      }

      store.models[name as Provider] = models;
    }

    if (isRecord(parsed.active)) {
      for (const [name, model] of Object.entries(parsed.active)) {
        if (typeof model === 'string') {
          store.active[name as Provider] = model;
        }
      }
    }

    return store;
  } catch (error) {
    log.warn(`Could not read ${storePath}: ${describeError(error)}`);

    return emptyStore();
  }
};

export const saveStore = (store: ModelStore) => {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(storePath, stringify(store));
  } catch (error) {
    // the session can still run on the entry that was chosen - it just will not
    // be there next time, which is worth saying but not worth stopping for
    log.warn(`Could not write ${storePath}: ${describeError(error)}`);
  }
};

// the configured provider's half of the store - the only one a run looks at
export const savedModels = (store: ModelStore) =>
  store.models[provider.name] ?? [];

export const activeModel = (store: ModelStore) => store.active[provider.name];

export const findEntry = (store: ModelStore, model?: string) =>
  savedModels(store).find((entry) => entry.model === model);

// a name typed after /model. a bare name finds the :latest entry ollama saved
// it under, the same way preflight matches it against the server
export const findTyped = (store: ModelStore, name: string) =>
  findEntry(store, name) ??
  savedModels(store).find(({ model }) => matchesModel(model, name));

// the only writer of these two settings. every consumer reads them at call time
// - preflight before a turn, the tokenizer when it builds a cache path - so
// there is nothing else to notify
export const applyEntry = (entry: ModelEntry) => {
  provider.model = entry.model;
  tokenizer.repo = entry.tokenizer;
};

// which model the next run on this provider starts on
export const markActive = (model: string) => {
  const store = loadStore();

  store.active[provider.name] = model;
  saveStore(store);
};

// upsert by model name: choosing a model that is already saved with a different
// tokenizer is how a mismatched pair gets corrected, so the new one wins. the
// other providers' lists are left as they were
export const rememberEntry = (entry: ModelEntry) => {
  const store = loadStore();
  const models = savedModels(store).filter(
    ({ model }) => model !== entry.model
  );

  models.push(entry);
  store.models[provider.name] = models;
  store.active[provider.name] = entry.model;
  saveStore(store);

  return entry;
};

// the other half of rememberEntry. an active name left pointing at nothing
// would be ignored on the next start anyway, but it is cleared rather than left
// for a hand-edit to trip over
export const forgetEntry = (model: string) => {
  const store = loadStore();

  store.models[provider.name] = savedModels(store).filter(
    (entry) => entry.model !== model
  );

  if (activeModel(store) === model) {
    delete store.active[provider.name];
  }

  saveStore(store);
};

// every entry the configured provider has, and which of them was active. the
// other providers' lists are left as they were
export const clearModels = () => {
  const store = loadStore();

  store.models[provider.name] = [];
  delete store.active[provider.name];
  saveStore(store);
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
  api?: PreflightApi,
  known?: Awaited<ReturnType<typeof listModels>>
): Promise<ModelEntry | undefined> => {
  const installed = known ?? (await listModels(api));

  if (!installed) {
    return;
  }

  const names = installed.map((model) => model.name).filter(Boolean);

  try {
    let model = await select({
      message: 'Which model?',
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

    if (!usesHfTokenizer()) {
      return { model };
    }

    const repo = (
      await input({
        message:
          'Which huggingface.co repo (or local directory) has its tokenizer? (optional - enter to use estimate)',
        validate: validateRepo
      })
    ).trim();

    // left out rather than saved as '', which loadStore would refuse
    return repo ? { model, tokenizer: repo } : { model };
  } catch (error) {
    return cancelled(error);
  }
};

// pick one of the saved pairs, or set up a new one. the caller decides what to
// do with it - this neither saves nor applies anything, except that a pair the
// user removes from the list is gone from the store as soon as they say so
export const chooseEntry = async (
  api?: PreflightApi
): Promise<ModelEntry | undefined> => {
  const store = loadStore();

  if (!savedModels(store).length) {
    return addEntry(api);
  }

  const installed = await listModels(api);

  // nothing is marked when the server could not be asked - listModels has
  // already said so, and a list of every model in red would say nothing more
  const names = (installed ?? [])
    .flatMap((model) => [model.name, model.id])
    .filter(Boolean);
  const isMissing = (model: string) =>
    Boolean(installed) && !names.some((name) => matchesModel(name, model));

  let model;

  try {
    model = await pickModel({
      message: 'Which model?',
      choices: [
        ...savedModels(store).map((entry) => ({
          name: entry.tokenizer
            ? `${entry.model} ${chalk.gray(`(${entry.tokenizer})`)}`
            : entry.model,
          value: entry.model,
          missing: isMissing(entry.model),
          // switchModel falls back to this entry when a switch fails, so it
          // has to still be there
          locked:
            entry.model === provider.model
              ? `${entry.model} is in use and cannot be removed`
              : undefined
        })),
        {
          name: 'Add a new model…',
          value: other,
          locked: 'Only a saved model can be removed'
        }
      ],
      default: activeModel(store),
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

// the first-run flow: the store has nothing for this provider, so the user is
// asked to add a model, which becomes the active one
const setUpEntry = async (
  api?: PreflightApi,
  known?: Awaited<ReturnType<typeof listModels>>
) => {
  log.info(chalk.green('No model has been set up yet'));

  const chosen = await addEntry(api, known);

  if (!chosen) {
    return false;
  }

  applyEntry(rememberEntry(chosen));

  return true;
};

// the server no longer has the model this run would start on. the saved list
// is offered up for clearing rather than left to fail preflight on every start
// - but only if the user says so, since the model may just not be pulled yet
const replaceMissing = async (
  model: string,
  installed: NonNullable<Awaited<ReturnType<typeof listModels>>>,
  api: PreflightApi = chatProvider
) => {
  log.warn(chalk.red(`${model} is no longer available from ${api.label}`));

  let clear;

  try {
    clear = await confirm({
      message: `Clear the saved ${provider.name} models and choose a new one?`,
      default: false
    });
  } catch (error) {
    cancelled(error);
  }

  if (!clear) {
    return false;
  }

  clearModels();

  return setUpEntry(api, installed);
};

// run before preflight: nothing else works until the config knows which model
// it is talking about. a store with an active entry starts without a prompt,
// which is the ordinary case - the question is only asked on a fresh install,
// or when the server has lost the model the store points at
export const resolveStartupEntry = async (api?: PreflightApi) => {
  const store = loadStore();
  const active = findEntry(store, activeModel(store)) ?? savedModels(store)[0];

  // exec has nobody to answer a question, so a missing model is left for
  // preflight to report
  if (active && !terminal.interactive) {
    applyEntry(active);

    return true;
  }

  if (active) {
    const installed = await listModels(api);

    // listModels has already said why, and preflight could get no further
    if (!installed) {
      return false;
    }

    if (!isInstalled(installed, active.model)) {
      return replaceMissing(active.model, installed, api);
    }

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

  return setUpEntry(api);
};
