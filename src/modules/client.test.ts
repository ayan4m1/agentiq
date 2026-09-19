import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ollama } from './config';

// the client is built as the module is evaluated, so each case sets the config
// first and then evaluates a copy of its own - a query string makes the URL,
// and so the module instance, distinct
const load = async (tag: string) =>
  (await import(new URL(`./client.ts?${tag}`, import.meta.url).href)).client;

describe('client', () => {
  test('talks to the configured host', async () => {
    ollama.host = 'http://ollama.test:4321';
    ollama.bearerToken = undefined;

    const client = await load('host');

    assert.equal(client.config.host, 'http://ollama.test:4321');
  });

  test('sends a bearer token when one is configured', async () => {
    ollama.host = 'http://ollama.test:4321';
    ollama.bearerToken = 'secret';

    const client = await load('token');

    assert.deepEqual(client.config.headers, {
      Authorization: 'Bearer secret'
    });
  });

  test('sends no authorization header without a token', async () => {
    ollama.host = 'http://ollama.test:4321';
    ollama.bearerToken = undefined;

    const client = await load('no-token');

    assert.equal(client.config.headers, undefined);
  });
});
