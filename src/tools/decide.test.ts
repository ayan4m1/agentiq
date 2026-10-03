import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { ModuleMock } from '../../test/fakes/module';
import type { DecisionRequest, DecisionResponse } from '../types';

// the real call goes to an ollama server, so the provider answers whatever the
// test says to. it is a plain object so a case can take decide away from it
const decide =
  mock.fn<(request: DecisionRequest) => Promise<DecisionResponse>>();
const chatProvider: { decide?: typeof decide } = { decide };

mock.module('../providers', {
  exports: { chatProvider } as ModuleMock<typeof import('../providers')>
});

const { decide: decideConfig } = await import('../modules/config');
const { definition, handler } = await import('./decide');

beforeEach(() => {
  decideConfig.model = 'kev-9b';
  chatProvider.decide = decide;
  decide.mock.resetCalls();
  decide.mock.mockImplementation(async () => ({ probabilities: [] }));
});

describe('decide', () => {
  test('requires a context and a list of questions', () => {
    const { parameters } = definition.function;

    assert.deepEqual(parameters?.required, ['context', 'questions']);
    assert.equal(parameters?.properties?.context?.type, 'string');
    assert.equal(parameters?.properties?.questions?.type, 'array');
    assert.deepEqual(parameters?.properties?.questions?.items, {
      type: 'string'
    });
  });

  test('asks the configured model, with the context as the state', async () => {
    await handler({
      context: 'CI is red on main',
      questions: ['Is the build broken?', 'Is it flaky?']
    });

    assert.equal(decide.mock.callCount(), 1);
    assert.deepEqual(decide.mock.calls[0].arguments, [
      {
        model: 'kev-9b',
        state: 'CI is red on main',
        questions: ['Is the build broken?', 'Is it flaky?']
      }
    ]);
  });

  test('reports a likely question as probably yes', async () => {
    decide.mock.mockImplementationOnce(async () => ({
      probabilities: [0.82]
    }));

    assert.equal(
      await handler({ context: 'CI is red', questions: ['Is it broken?'] }),
      'You asked "Is it broken?", the answer is probably yes (82% yes).'
    );
  });

  test('reports an unlikely question as probably no', async () => {
    decide.mock.mockImplementationOnce(async () => ({
      probabilities: [0.1]
    }));

    assert.equal(
      await handler({ context: 'CI is green', questions: ['Is it broken?'] }),
      'You asked "Is it broken?", the answer is probably no (10% yes).'
    );
  });

  test('counts an even chance as yes', async () => {
    decide.mock.mockImplementationOnce(async () => ({
      probabilities: [0.5]
    }));

    assert.match(
      await handler({ context: 'unclear', questions: ['Is it broken?'] }),
      /probably yes \(50% yes\)/
    );
  });

  test('answers each question on a line of its own, in order', async () => {
    decide.mock.mockImplementationOnce(async () => ({
      probabilities: [0.9, 0.2]
    }));

    assert.equal(
      await handler({
        context: 'CI is red',
        questions: ['Is it broken?', 'Is it flaky?']
      }),
      [
        'You asked "Is it broken?", the answer is probably yes (90% yes).',
        'You asked "Is it flaky?", the answer is probably no (20% yes).'
      ].join('\n')
    );
  });

  test('says so when a question got no answer', async () => {
    decide.mock.mockImplementationOnce(async () => ({
      probabilities: [0.9, undefined]
    }));

    const result = await handler({
      context: 'CI is red',
      questions: ['Is it broken?', 'Is it flaky?']
    });

    assert.match(
      result,
      /You asked "Is it flaky\?", but no answer came back for it\./
    );
  });

  test('asks for a question rather than calling with none', async () => {
    assert.equal(
      await handler({ context: 'CI is red', questions: [] }),
      'Ask at least one yes/no question.'
    );
    assert.equal(decide.mock.callCount(), 0);
  });

  test('passes a failed call on to the caller', async () => {
    decide.mock.mockImplementationOnce(async () => {
      throw new Error('model not found');
    });

    await assert.rejects(
      handler({ context: 'CI is red', questions: ['Is it broken?'] }),
      /model not found/
    );
  });

  test('refuses when the provider cannot decide', async () => {
    delete chatProvider.decide;

    await assert.rejects(
      handler({ context: 'CI is red', questions: ['Is it broken?'] }),
      /needs the ollama provider/
    );
  });

  test('refuses when no decision model is configured', async () => {
    decideConfig.model = undefined;

    await assert.rejects(
      handler({ context: 'CI is red', questions: ['Is it broken?'] }),
      /decide\.model/
    );
    assert.equal(decide.mock.callCount(), 0);
  });
});
