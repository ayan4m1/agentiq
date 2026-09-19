import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ListResponse, ShowResponse } from 'ollama';

import { ollama } from './config';
import {
  matchesModel,
  preflight,
  readContextLength,
  supportsThinking
} from './preflight';

// winston writes straight to the streams, and these tests deliberately drive
// the paths that report a problem
const quietly = async <T>(work: () => Promise<T>) => {
  const out = process.stdout.write;
  const err = process.stderr.write;

  process.stdout.write = () => true;
  process.stderr.write = () => true;

  try {
    return await work();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
};

const named = (...names: string[]) =>
  ({
    models: names.map((name) => ({ name, model: name }))
  }) as ListResponse;

const showing = (details: Partial<ShowResponse>) =>
  ({ capabilities: [], model_info: {}, ...details }) as ShowResponse;

// an api that answers with whatever the test needs
const api = (options: {
  list?: () => Promise<ListResponse>;
  show?: () => Promise<ShowResponse>;
}) => ({
  list: options.list ?? (() => Promise.resolve(named(ollama.model))),
  show: options.show ?? (() => Promise.resolve(showing({})))
});

describe('matchesModel', () => {
  test('matches an exact name', () => {
    assert.ok(matchesModel('gemma3:12b', 'gemma3:12b'));
  });

  test('resolves a bare name to the latest tag, as ollama does', () => {
    assert.ok(matchesModel('gemma3:latest', 'gemma3'));
  });

  test('does not treat a bare name as any other tag', () => {
    assert.ok(!matchesModel('gemma3:12b', 'gemma3'));
  });

  test('does not ignore a tag the user asked for', () => {
    assert.ok(!matchesModel('gemma3:latest', 'gemma3:12b'));
  });

  test('does not match a different model whose name starts the same', () => {
    assert.ok(!matchesModel('gemma3-tuned:latest', 'gemma3'));
  });
});

describe('readContextLength', () => {
  test('reads the key named for the architecture', () => {
    assert.equal(
      readContextLength({
        'general.architecture': 'gemma3',
        'gemma3.context_length': 131072,
        'llama.context_length': 4096
      } as unknown as ShowResponse['model_info']),
      131072
    );
  });

  test('reads it out of a real Map too', () => {
    const info = new Map<string, unknown>([
      ['general.architecture', 'qwen3'],
      ['qwen3.context_length', 40960]
    ]);

    assert.equal(readContextLength(info as ShowResponse['model_info']), 40960);
  });

  test('falls back to any context length when the architecture is missing', () => {
    assert.equal(
      readContextLength({
        'mystery.context_length': 8192
      } as unknown as ShowResponse['model_info']),
      8192
    );
  });

  test('returns nothing when there is no context length at all', () => {
    assert.equal(
      readContextLength({
        'general.architecture': 'gemma3'
      } as unknown as ShowResponse['model_info']),
      undefined
    );
  });

  test('ignores a context length that is not a number', () => {
    assert.equal(
      readContextLength({
        'general.architecture': 'gemma3',
        'gemma3.context_length': 'lots'
      } as unknown as ShowResponse['model_info']),
      undefined
    );
  });

  test('survives model_info being absent', () => {
    assert.equal(
      readContextLength(undefined as unknown as ShowResponse['model_info']),
      undefined
    );
  });
});

describe('preflight', () => {
  test('passes when the configured model is installed', async () => {
    assert.equal(await quietly(() => preflight(api({}))), true);
  });

  test('fails when the server cannot be reached', async () => {
    const result = await quietly(() =>
      preflight(api({ list: () => Promise.reject(new Error('ECONNREFUSED')) }))
    );

    assert.equal(result, false);
  });

  test('fails when the model is not installed', async () => {
    const result = await quietly(() =>
      preflight(api({ list: () => Promise.resolve(named('something-else')) }))
    );

    assert.equal(result, false);
  });

  test('fails rather than starting with nothing installed', async () => {
    const result = await quietly(() =>
      preflight(api({ list: () => Promise.resolve(named()) }))
    );

    assert.equal(result, false);
  });

  test('matches an installed model by its implicit latest tag', async () => {
    const bare = ollama.model.split(':')[0];
    const result = await quietly(() =>
      preflight({
        list: () => Promise.resolve(named(`${bare}:latest`)),
        show: () => Promise.resolve(showing({}))
      })
    );

    // only meaningful when the configured model has no tag of its own
    assert.equal(result, ollama.model.includes(':') ? false : true);
  });

  test('still starts when the model cannot call tools', async () => {
    // loud, but the user may have meant to chat - and refusing to start would
    // be a worse answer than saying so
    const result = await quietly(() =>
      preflight(
        api({
          show: () => Promise.resolve(showing({ capabilities: ['completion'] }))
        })
      )
    );

    assert.equal(result, true);
  });

  test('still starts when the context limit is too high for the model', async () => {
    const result = await quietly(() =>
      preflight(
        api({
          show: () =>
            Promise.resolve(
              showing({
                model_info: {
                  'general.architecture': 'gemma3',
                  'gemma3.context_length': 1
                } as unknown as ShowResponse['model_info']
              })
            )
        })
      )
    );

    assert.equal(result, true);
  });

  test('still starts when the details call fails outright', async () => {
    // the model is installed, and everything show() adds is advisory
    const result = await quietly(() =>
      preflight(
        api({ show: () => Promise.reject(new Error('no such endpoint')) })
      )
    );

    assert.equal(result, true);
  });
});

describe('supportsThinking', () => {
  const reporting = (...reported: string[]) =>
    api({ show: () => Promise.resolve(showing({ capabilities: reported })) });

  test('is true for a model that reports it', async () => {
    await quietly(() => preflight(reporting('tools', 'thinking')));

    assert.equal(supportsThinking(), true);
  });

  test('is false for a model that does not', async () => {
    await quietly(() => preflight(reporting('tools')));

    assert.equal(supportsThinking(), false);
  });

  test('does not carry an answer over from a previous model', async () => {
    await quietly(() => preflight(reporting('tools', 'thinking')));
    await quietly(() => preflight(reporting('tools')));

    assert.equal(supportsThinking(), false);
  });

  test('is false when the model could not be asked at all', async () => {
    await quietly(() => preflight(reporting('tools', 'thinking')));
    await quietly(() =>
      preflight(api({ show: () => Promise.reject(new Error('no endpoint')) }))
    );

    // assuming a capability that was never confirmed would put a setting on
    // every request that the server may reject
    assert.equal(supportsThinking(), false);
  });

  test('is false when the server was never reachable', async () => {
    await quietly(() => preflight(reporting('tools', 'thinking')));
    await quietly(() =>
      preflight(api({ list: () => Promise.reject(new Error('ECONNREFUSED')) }))
    );

    assert.equal(supportsThinking(), false);
  });
});
