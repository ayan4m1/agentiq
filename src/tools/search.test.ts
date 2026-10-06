import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Hit = { title: string; url: string; description: string };

// what the fake API answers the next request with, and what it was sent
let reply: { status: number; body: unknown };
let received: { headers: IncomingHttpHeaders; body: unknown } | undefined;

const respondWith = (results: Hit[]) => {
  reply = {
    status: 200,
    body: {
      requestId: 'test',
      result: {
        results,
        searchMetadata: { executionTime: 0.1 },
        totalResults: results.length
      }
    }
  };
};

const hit = (n: number): Hit => ({
  title: `Result ${n}`,
  url: `https://example.com/${n}`,
  description: `About ${n}`
});

let server: Server;
let ceramic: { perTurnLimit: number };
let beginUserTurn: () => void;

before(async () => {
  server = createServer((request, response) => {
    let body = '';

    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received = { headers: request.headers, body: JSON.parse(body || '{}') };
      response
        .writeHead(reply.status, { 'content-type': 'application/json' })
        .end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  // config is read once, at its first import - so the key goes in first
  process.env.AQ_CERAMIC_API_KEY = 'cer-test';
  ({ ceramic } = await import('../modules/config'));
  ({ beginUserTurn } = await import('../modules/turn'));
});

after(() => {
  server.close();
});

beforeEach(() => {
  received = undefined;
  ceramic.perTurnLimit = 8;
  beginUserTurn();
});

// the client is built on the first call, from the key in config and the base
// URL the SDK reads itself - both have to be in place before the import
const loadHandler = async () => {
  process.env.AQ_CERAMIC_API_KEY = 'cer-test';
  process.env.CERAMIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return (await import('./search')).handler;
};

describe('search', () => {
  test('lists each hit as a link under a header naming the query', async () => {
    const handler = await loadHandler();

    respondWith([hit(1), hit(2)]);

    assert.equal(
      await handler({ query: 'node test runner' }),
      'Got 2 results for "node test runner":\n\n' +
        '- [Result 1](https://example.com/1) - About 1\n' +
        '- [Result 2](https://example.com/2) - About 2'
    );
  });

  test('sends the query, a result limit and the key', async () => {
    const handler = await loadHandler();

    respondWith([hit(1)]);
    await handler({ query: 'typescript' });

    assert.deepEqual(received?.body, { query: 'typescript', maxResults: 10 });
    assert.equal(received?.headers.authorization, 'Bearer cer-test');
  });

  test('keeps no more than ten hits', async () => {
    const handler = await loadHandler();

    respondWith(Array.from({ length: 15 }, (_, n) => hit(n + 1)));

    const result = await handler({ query: 'many' });

    assert.match(result, /^Got 10 results for "many":/);
    assert.equal(
      result.split('\n').filter((line) => line.startsWith('- ')).length,
      10
    );
  });

  test('says so when nothing was found', async () => {
    const handler = await loadHandler();

    respondWith([]);

    assert.equal(await handler({ query: 'xyzzy' }), 'No results for "xyzzy"');
  });

  test('reports an error from the API', async () => {
    const handler = await loadHandler();

    // a 4xx, since the SDK retries a 5xx
    reply = { status: 400, body: { error: 'bad query' } };

    assert.match(
      await handler({ query: 'oops' }),
      /^The search failed with error: 400/
    );
  });

  test('refuses once the per-turn limit is reached, without a request', async () => {
    const handler = await loadHandler();

    ceramic.perTurnLimit = 2;
    respondWith([hit(1)]);
    await handler({ query: 'one' });
    await handler({ query: 'two' });
    received = undefined;

    assert.match(
      await handler({ query: 'three' }),
      /^Not searching for "three" - the limit of 2 searches per message/
    );
    assert.equal(received, undefined);
  });

  test('searches again once the user sends another message', async () => {
    const handler = await loadHandler();

    ceramic.perTurnLimit = 1;
    respondWith([hit(1)]);
    await handler({ query: 'one' });
    beginUserTurn();

    assert.match(await handler({ query: 'two' }), /^Got 1 results/);
  });

  test('counts a failed search towards the limit', async () => {
    const handler = await loadHandler();

    ceramic.perTurnLimit = 1;
    reply = { status: 400, body: { error: 'bad query' } };
    await handler({ query: 'oops' });
    respondWith([hit(1)]);

    assert.match(await handler({ query: 'again' }), /^Not searching/);
  });

  test('never refuses when the limit is 0', async () => {
    const handler = await loadHandler();

    ceramic.perTurnLimit = 0;
    respondWith([hit(1)]);

    for (let n = 0; n < 12; n++) {
      assert.match(await handler({ query: `q${n}` }), /^Got 1 results/);
    }
  });
});
