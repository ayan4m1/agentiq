import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ListResponse, ShowResponse } from 'ollama';

import { ollama } from './config';
import {
  matchesModel,
  preflight,
  resolveThink,
  supportsThinking
} from './preflight';

// the model is no longer read from the environment - modules/models.ts sets it
// from the saved store - so these tests say which one they are checking against
// rather than inheriting whatever a developer's .env happened to name. it is
// deliberately untagged, so the implicit-latest case below has something to
// match against
ollama.model = 'test-model';

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
    const result = await quietly(() =>
      preflight({
        list: () => Promise.resolve(named(`${ollama.model}:latest`)),
        show: () => Promise.resolve(showing({}))
      })
    );

    assert.equal(result, true);
  });

  test('fails when no model has been chosen', async () => {
    // /model has not been run and the store is empty - the session cannot
    // start, and the list of what is installed is the most useful answer
    const chosen = ollama.model;

    ollama.model = '';

    try {
      assert.equal(await quietly(() => preflight(api({}))), false);
    } finally {
      ollama.model = chosen;
    }
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

describe('resolveThink', () => {
  const reporting = (...reported: string[]) =>
    api({ show: () => Promise.resolve(showing({ capabilities: reported })) });

  // the setting is shared config, so whatever a test chooses must not leak
  const withSetting = (think: boolean | undefined, check: () => void) => {
    ollama.think = think;

    try {
      check();
    } finally {
      ollama.think = undefined;
    }
  };

  test('asks a model that can reason to do so', async () => {
    await quietly(() => preflight(reporting('tools', 'thinking')));

    withSetting(undefined, () => assert.equal(resolveThink(), true));
  });

  test('leaves reasoning to the server default for a model that cannot', async () => {
    await quietly(() => preflight(reporting('tools')));

    withSetting(undefined, () => assert.equal(resolveThink(), undefined));
  });

  test('lets an explicit setting win, even an explicit false', async () => {
    // the model says it can reason, and the user said not to
    await quietly(() => preflight(reporting('tools', 'thinking')));

    withSetting(false, () => assert.equal(resolveThink(), false));
  });

  test('lets an explicit true through for a model that does not report it', async () => {
    await quietly(() => preflight(reporting('tools')));

    withSetting(true, () => assert.equal(resolveThink(), true));
  });
});
