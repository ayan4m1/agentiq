import { homedir } from 'node:os';
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
import { tokenizer as config } from './config';

const log = getLogger('tokenizer');
const fileNames = ['tokenizer.json', 'tokenizer_config.json'];
// the repo name is joined into a filesystem path, so anything but a plain
// owner/name pair - a `..` segment above all - has to be rejected outright
const repoPattern = /^[\w.-]+\/[\w.-]+$/;

const getCacheDir = () => {
  if (!config.repo) {
    throw new Error(
      'No tokenizer is configured - set AQ_HF_TOKENIZER_REPO to a huggingface.co repository, e.g. google/gemma-3-12b-it'
    );
  }

  if (!repoPattern.test(config.repo)) {
    throw new Error(
      `AQ_HF_TOKENIZER_REPO must be an owner/name pair, got "${config.repo}"`
    );
  }

  return resolve(homedir(), '.agentiq', 'tokenizers', config.repo);
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
  const missing = fileNames.filter(
    (fileName) => !existsSync(resolve(cacheDir, fileName))
  );

  if (!missing.length) {
    return;
  }

  mkdirSync(cacheDir, { recursive: true });

  for (const fileName of missing) {
    await download(fileName, cacheDir);
  }
};

export const makeTokenizer = () => {
  const cacheDir = getCacheDir();
  const tokenizer = TokenizerLoader.fromPreTrained({
    tokenizerConfig: JSON.parse(
      readFileSync(resolve(cacheDir, 'tokenizer_config.json')).toString()
    ),
    tokenizerJSON: JSON.parse(
      readFileSync(resolve(cacheDir, 'tokenizer.json')).toString()
    )
  });

  return (value: string) => tokenizer.encode(value).length;
};
