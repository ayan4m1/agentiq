import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

// the cache lives under the state directory, which has to be somewhere a test
// can fill and inspect - and it is read once, when the config first evaluates
process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-tokenizer-'));

// the real loader wants a real tokenizer.json, tens of megabytes of it. one
// token per character is enough to tell its count apart from the estimate
const fromPreTrained = mock.fn<
  (files: unknown) => { encode: (value: string) => string[] }
>(() => ({
  encode: (value: string) => [...value]
}));

mock.module('@lenml/tokenizers', {
  namedExports: { TokenizerLoader: { fromPreTrained } }
});

const { estimateTokens, ensureTokenizer, makeTokenizer } =
  await import('./tokenizer');
const { home, tokenizer: config } = await import('./config');
const { charsPerToken } = await import('../utils');

const fileNames = ['tokenizer.json', 'tokenizer_config.json'];

// every test gets a repo of its own, so no cache one leaves behind is found by
// the next
let repoCount = 0;
const freshRepo = () => `test/repo-${++repoCount}`;
const cacheDir = (repo: string) => resolve(home, 'tokenizers', repo);

const seedCache = (repo: string, files: Record<string, string>) => {
  mkdirSync(cacheDir(repo), { recursive: true });

  for (const [fileName, contents] of Object.entries(files)) {
    writeFileSync(resolve(cacheDir(repo), fileName), contents);
  }
};

const fetched = mock.method(
  globalThis,
  'fetch',
  (async () => new Response('{}', { status: 200 })) as typeof fetch
);
const fetchedUrls = () =>
  fetched.mock.calls.map((call) => String(call.arguments[0]));

beforeEach(() => {
  config.repo = undefined;
  config.hfToken = undefined;
  fetched.mock.resetCalls();
  fetched.mock.mockImplementation(
    async () => new Response('{}', { status: 200 })
  );
  fromPreTrained.mock.resetCalls();
  fromPreTrained.mock.mockImplementation(() => ({
    encode: (value: string) => [...value]
  }));
});

describe('estimateTokens', () => {
  test('counts nothing for an empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('divides by the same ratio the content budgets assume', () => {
    const value = 'x'.repeat(1000);

    assert.equal(estimateTokens(value), Math.ceil(1000 / charsPerToken));
  });

  test('never reports zero for content that exists', () => {
    // a message counted as free would be invisible to the compaction trigger
    assert.equal(estimateTokens('a'), 1);
  });

  test('grows with the length of the content', () => {
    assert.ok(estimateTokens('a'.repeat(100)) > estimateTokens('a'.repeat(10)));
  });

  test('stays within a plausible factor of a real tokenizer', () => {
    // prose runs about four characters to the token, so an estimate that is
    // wildly off would push compaction at the wrong time on every turn
    const prose =
      'The quick brown fox jumps over the lazy dog, and then does it again.';
    const estimate = estimateTokens(prose);

    assert.ok(estimate > prose.length / 8, 'should not be wildly low');
    assert.ok(estimate < prose.length / 2, 'should not be wildly high');
  });
});

describe('ensureTokenizer', () => {
  test('reports failure without a network call when no repo is configured', async () => {
    assert.equal(await ensureTokenizer(), false);
    assert.equal(fetched.mock.callCount(), 0);
  });

  test('refuses a repo name that is not an owner/name pair', async () => {
    // the name is joined into a filesystem path, so a traversal must never
    // reach mkdirSync, let alone a download
    for (const repo of [
      '../evil',
      'owner/..',
      '../..',
      'a/b/c',
      'no-slash',
      'a\\b/c',
      '/abs'
    ]) {
      config.repo = repo;

      assert.equal(await ensureTokenizer(), false, repo);
    }

    assert.equal(fetched.mock.callCount(), 0);
  });

  test('uses a complete cache as it stands', async () => {
    const repo = freshRepo();

    seedCache(repo, { 'tokenizer.json': '{}', 'tokenizer_config.json': '{}' });
    config.repo = repo;

    assert.equal(await ensureTokenizer(), true);
    assert.equal(fetched.mock.callCount(), 0);
  });

  test('downloads both files into the cache when neither is there', async () => {
    const repo = freshRepo();

    config.repo = repo;
    fetched.mock.mockImplementation(
      async (url) => new Response(`from ${String(url)}`, { status: 200 })
    );

    assert.equal(await ensureTokenizer(), true);
    assert.deepEqual(
      fetchedUrls(),
      fileNames.map(
        (fileName) => `https://huggingface.co/${repo}/resolve/main/${fileName}`
      )
    );

    for (const fileName of fileNames) {
      const target = resolve(cacheDir(repo), fileName);

      assert.ok(existsSync(target), fileName);
      assert.equal(existsSync(`${target}.tmp`), false, `${fileName}.tmp`);
    }
  });

  test('downloads only what the cache is missing', async () => {
    const repo = freshRepo();

    seedCache(repo, { 'tokenizer.json': '{}' });
    config.repo = repo;

    assert.equal(await ensureTokenizer(), true);
    assert.deepEqual(fetchedUrls(), [
      `https://huggingface.co/${repo}/resolve/main/tokenizer_config.json`
    ]);
  });

  test('sends the huggingface token when one is configured', async () => {
    config.repo = freshRepo();
    config.hfToken = 'hf_secret';

    await ensureTokenizer();

    for (const call of fetched.mock.calls) {
      assert.deepEqual(call.arguments[1]?.headers, {
        Authorization: 'Bearer hf_secret'
      });
    }
  });

  test('sends no headers at all without a token', async () => {
    config.repo = freshRepo();

    await ensureTokenizer();

    for (const call of fetched.mock.calls) {
      assert.equal(call.arguments[1]?.headers, undefined);
    }
  });

  test('reports failure rather than throwing on an error response', async () => {
    // once without a token and once with, since each says something different
    // about what to do next
    for (const hfToken of [undefined, 'hf_secret']) {
      const repo = freshRepo();

      config.repo = repo;
      config.hfToken = hfToken;
      fetched.mock.mockImplementation(
        async () => new Response('not found', { status: 404 })
      );

      assert.equal(await ensureTokenizer(), false);
      assert.equal(
        existsSync(resolve(cacheDir(repo), 'tokenizer.json')),
        false
      );
    }
  });

  test('leaves nothing behind when a download drops partway through', async () => {
    const repo = freshRepo();
    const target = resolve(cacheDir(repo), 'tokenizer.json');

    config.repo = repo;
    fetched.mock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"trunc'));
              controller.error(new Error('connection reset'));
            }
          }),
          { status: 200 }
        )
    );

    // a truncated file under the real name would pass for a valid cache on
    // every run from here on
    assert.equal(await ensureTokenizer(), false);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(`${target}.tmp`), false);
  });
});

describe('makeTokenizer', () => {
  test('estimates when no repo is configured', () => {
    assert.equal(makeTokenizer(), estimateTokens);
    assert.equal(fromPreTrained.mock.callCount(), 0);
  });

  test('estimates when the repo name is refused', () => {
    config.repo = '../evil';

    assert.equal(makeTokenizer(), estimateTokens);
  });

  test('counts with the cached tokenizer when there is one', () => {
    const repo = freshRepo();

    seedCache(repo, {
      'tokenizer.json': '{"model":"json"}',
      'tokenizer_config.json': '{"model":"config"}'
    });
    config.repo = repo;

    const count = makeTokenizer();

    assert.notEqual(count, estimateTokens);
    assert.equal(count('abcd'), 4);
    assert.deepEqual(fromPreTrained.mock.calls[0].arguments[0], {
      tokenizerConfig: { model: 'config' },
      tokenizerJSON: { model: 'json' }
    });
  });

  test('estimates when the cache is missing a file', () => {
    const repo = freshRepo();

    seedCache(repo, { 'tokenizer_config.json': '{}' });
    config.repo = repo;

    assert.equal(makeTokenizer(), estimateTokens);
  });

  test('estimates when the cache holds something that is not JSON', () => {
    const repo = freshRepo();

    seedCache(repo, {
      'tokenizer.json': '{"trunc',
      'tokenizer_config.json': '{}'
    });
    config.repo = repo;

    assert.equal(makeTokenizer(), estimateTokens);
  });

  test('estimates when the loader cannot read the tokenizer', () => {
    const repo = freshRepo();

    seedCache(repo, { 'tokenizer.json': '{}', 'tokenizer_config.json': '{}' });
    config.repo = repo;
    fromPreTrained.mock.mockImplementation(() => {
      throw new Error('unsupported model type');
    });

    assert.equal(makeTokenizer(), estimateTokens);
  });
});
