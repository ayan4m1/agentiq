import { resolve } from 'node:path';
import { filesize } from 'filesize';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TokenizerLoader } from '@lenml/tokenizers';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';

import { getLogger } from './logging';
import { home, tokenizer as config } from './config';
import { charsPerToken, describeError } from '../utils';

const log = getLogger('tokenizer');
const fileNames = ['tokenizer.json', 'tokenizer_config.json'];
// the repo name is joined into a filesystem path, so anything but a plain
// owner/name pair - a `..` segment above all - has to be rejected outright
// neither half may be dots alone, which the character class would otherwise
// let through as a `..` segment
const repoPattern = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;

// a rough count for when no real tokenizer is available. ollama reports the
// true size of every prompt it renders, so this only has to be close enough to
// get as far as the first response
export const estimateTokens = (value: string) =>
  Math.ceil(value.length / charsPerToken);

// undefined rather than a throw: counting falls back to an estimate that the
// server corrects on the first turn, which is not worth refusing to start over
const getCacheDir = () => {
  if (!config.repo) {
    return;
  }

  if (!repoPattern.test(config.repo)) {
    log.warn(
      `Ignoring the tokenizer repo "${config.repo}" - expected an owner/name pair`
    );

    return;
  }

  return resolve(home, 'tokenizers', config.repo);
};

const download = async (fileName: string, targetDir: string) => {
  const url = `https://huggingface.co/${config.repo}/resolve/main/${fileName}`;
  const response = await fetch(url, {
    headers: config.hfToken
      ? {
          Authorization: `Bearer ${config.hfToken}`
        }
      : undefined
  });

  if (response.status !== 200 || !response.body) {
    // a gated repo answers 401/403 and a typo answers 404 - saying which is the
    // difference between "set AQ_HF_TOKEN" and "fix the repo name"
    throw new Error(
      `Got a ${response.status} response when fetching ${url} - ${config.hfToken ? 'the configured AQ_HF_TOKEN may not have access' : 'a gated repository needs AQ_HF_TOKEN set'}`
    );
  }

  const target = resolve(targetDir, fileName);
  // tokenizer.json runs to tens of megabytes, so a connection dropped partway
  // through must not leave a truncated file that looks like a valid cache
  const partial = `${target}.tmp`;

  log.info(`Downloading ${fileName} from ${config.repo}`);

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(partial)
    );
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }

  log.info(`Wrote ${filesize(statSync(target).size)} to ${target}`);
};

// fetches whatever the configured repo is missing from the cache. downloading
// is slow enough that it has to finish before the first prompt renders, so this
// is awaited at startup rather than lazily on first encode
export const ensureTokenizer = async () => {
  const cacheDir = getCacheDir();

  if (!cacheDir) {
    log.warn(
      'No tokenizer is configured - use /model to pair this model with a huggingface.co repository, e.g. google/gemma-3-12b-it.'
    );

    return false;
  }

  const missing = fileNames.filter(
    (fileName) => !existsSync(resolve(cacheDir, fileName))
  );

  if (!missing.length) {
    return true;
  }

  try {
    mkdirSync(cacheDir, { recursive: true });

    for (const fileName of missing) {
      await download(fileName, cacheDir);
    }

    return true;
  } catch (error) {
    // a gated repo, a typo, or no network - none of which should stop the
    // session before it has started
    log.warn(`Could not fetch the tokenizer: ${describeError(error)}`);

    return false;
  }
};

export const makeTokenizer = () => {
  const cacheDir = getCacheDir();

  if (!cacheDir) {
    return estimateTokens;
  }

  try {
    const tokenizer = TokenizerLoader.fromPreTrained({
      tokenizerConfig: JSON.parse(
        readFileSync(resolve(cacheDir, 'tokenizer_config.json')).toString()
      ),
      tokenizerJSON: JSON.parse(
        readFileSync(resolve(cacheDir, 'tokenizer.json')).toString()
      )
    });

    return (value: string) => tokenizer.encode(value).length;
  } catch (error) {
    // a half-written cache, or a tokenizer.json this loader cannot read
    log.warn(`Could not load the tokenizer: ${describeError(error)}`);

    return estimateTokens;
  }
};
