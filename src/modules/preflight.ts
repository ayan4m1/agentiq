import chalk from 'chalk';
import type { ListResponse, ShowResponse } from 'ollama';

import { client } from './client';
import { ollama } from './config';
import { getLogger } from './logging';
import { describeError } from '../utils';

const log = getLogger('preflight');

// what the server said this model can do, filled in by preflight() and read by
// the thinker. empty until then, which is the safe answer: nothing is assumed
// about a model that has not been asked about
const capabilities = new Set<string>();

export const supportsThinking = () => capabilities.has('thinking');

// the most context the model says it can take, for /context-limit to check a
// new value against. undefined when the server did not say
let contextLength: number | undefined;

export const modelContextLength = () => contextLength;

// only the two calls this needs, so a test can stand in for the server
export type Api = {
  list: () => Promise<ListResponse>;
  show: (request: { model: string }) => Promise<ShowResponse>;
};

// what the server has, or undefined when it could not be asked. modules/models.ts
// needs the same list to offer a choice of model, and an unreachable host is the
// same problem said the same way wherever it is noticed
export const listModels = async (api: Api = client) => {
  try {
    return (await api.list()).models;
  } catch (error) {
    log.error(
      chalk.red(
        `Could not reach ollama at ${ollama.host ?? 'its default address'} - ${describeError(error)}`
      )
    );
  }
};

// ollama stores every model under an explicit tag, and resolves a bare name to
// :latest - so a configured "gemma4" is the installed "gemma4:latest"
export const matchesModel = (installed: string, configured: string) =>
  installed === configured ||
  (!configured.includes(':') && installed === `${configured}:latest`);

// model_info is typed as a Map but arrives as parsed JSON, so it is a plain
// object in practice - handle both rather than betting on either
const entriesOf = (info: ShowResponse['model_info']): [string, unknown][] => {
  if (info instanceof Map) {
    return [...info.entries()];
  }

  return info ? Object.entries(info) : [];
};

// the key is namespaced by architecture - "gemma3.context_length" - so the
// architecture is read first, and any context length will do as a fallback
export const readContextLength = (info: ShowResponse['model_info']) => {
  const entries = entriesOf(info);
  const architecture = entries.find(
    ([key]) => key === 'general.architecture'
  )?.[1];
  const named = entries.find(
    ([key]) => key === `${architecture}.context_length`
  )?.[1];

  if (typeof named === 'number') {
    return named;
  }

  const any = entries.find(
    ([key, value]) =>
      key.endsWith('.context_length') && typeof value === 'number'
  )?.[1];

  return typeof any === 'number' ? any : undefined;
};

const listInstalled = (models: ListResponse['models']) => {
  if (!models.length) {
    log.error(
      chalk.red(
        'No models are installed - pull one first, e.g. ollama pull gemma3'
      )
    );

    return;
  }

  log.error(chalk.red('Installed models:'));

  for (const model of models) {
    console.log(`  ${model.name ?? model.model}`);
  }
};

// everything here is advisory: the model exists, and the session can go ahead
// even when these checks have something to say about it
const inspect = async (api: Api) => {
  let details;

  try {
    details = await api.show({ model: ollama.model });
  } catch (error) {
    log.debug(
      `Could not read details for ${ollama.model}: ${describeError(error)}`
    );

    return;
  }

  const reported = details.capabilities ?? [];

  for (const capability of reported) {
    capabilities.add(capability);
  }

  log.debug(
    `${ollama.model} reports capabilities: ${reported.join(', ') || 'none'}`
  );

  // asking a model that cannot reason to reason is an error from the server
  // rather than a no-op, so it would cost every turn of the session
  if (ollama.think && reported.length && !capabilities.has('thinking')) {
    log.warn(
      chalk.red(
        `AQ_OLLAMA_THINK is set, but ${ollama.model} does not report a thinking capability - the setting will be ignored`
      )
    );
  }

  // an older server may not report any, and a false alarm here would be worse
  // than the silence it is meant to replace
  if (reported.length && !capabilities.has('tools')) {
    log.warn(
      chalk.red(
        `${ollama.model} cannot call tools, so it will ignore all of them and only chat. Choose a model whose capabilities include "tools".`
      )
    );
  }

  contextLength = readContextLength(details.model_info);

  if (contextLength && ollama.contextLimit > contextLength) {
    // num_ctx above what the model supports is not an error anywhere - ollama
    // simply truncates the prompt, dropping the oldest messages in silence
    log.warn(
      chalk.red(
        `AQ_OLLAMA_CONTEXT_LIMIT is ${ollama.contextLimit}, but ${ollama.model} supports ${contextLength} - the prompt will be silently truncated. Lower it to ${contextLength} or less.`
      )
    );
  }
};

// run before the first prompt: an unreachable host or a model that is not
// there otherwise surfaces as a failed turn, after the user has typed
// something and waited for it
export const preflight = async (api: Api = client) => {
  // whatever was learned about a previous model says nothing about this one,
  // and a run that gets no further must not leave the old answer standing
  capabilities.clear();
  contextLength = undefined;

  const installed = await listModels(api);

  if (!installed) {
    return false;
  }

  if (!ollama.model) {
    log.error(chalk.red('No model is configured - use /model to choose one'));
    listInstalled(installed);

    return false;
  }

  const found = installed.some((model) =>
    [model.name, model.model].some(
      (name) => name && matchesModel(name, ollama.model)
    )
  );

  if (!found) {
    // deliberately no nearest-match guess: the list is the answer, and a guess
    // risks pointing at a model the user did not mean
    log.error(
      chalk.red(`The configured model "${ollama.model}" is not installed`)
    );
    listInstalled(installed);

    return false;
  }

  await inspect(api);

  return true;
};
