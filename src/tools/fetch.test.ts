import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// the character budget is sized from the context limit when the module is
// evaluated, so shrink it first - 100 tokens is a budget of 99 characters
process.env.AQ_OLLAMA_CONTEXT_LIMIT = '100';

const { handler } = await import('./fetch');

const pages: Record<string, { type: string; body: string }> = {
  '/page': {
    type: 'text/html; charset=utf-8',
    body: '<!DOCTYPE html><html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Hello</p><noscript>enable js</noscript></body></html>'
  },
  '/plain': {
    type: 'text/plain',
    body: '<p>not html</p>'
  },
  '/long': {
    type: 'text/plain',
    body: 'x'.repeat(200)
  }
};

let server: Server;
let base: string;

before(async () => {
  server = createServer((request, response) => {
    const page = pages[request.url ?? ''];

    if (!page) {
      response.writeHead(404).end();

      return;
    }

    response.writeHead(200, { 'content-type': page.type }).end(page.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('fetch', () => {
  test('says which URL it fetched, what it was and how big', async () => {
    const url = `${base}/plain`;

    assert.equal(
      (await handler({ url })).split('\n')[0],
      `Fetched ${url} (text/plain, 15 bytes)`
    );
  });

  test('reduces HTML to its text', async () => {
    const body = (await handler({ url: `${base}/page` })).split('\n\n')[1];

    assert.equal(body, 'Hello');
  });

  test('passes anything other than HTML through untouched', async () => {
    assert.match(
      await handler({ url: `${base}/plain` }),
      /\n\n<p>not html<\/p>$/
    );
  });

  test('truncates a body past the budget', async () => {
    assert.match(
      await handler({ url: `${base}/long` }),
      /\[truncated: showing 99 of 200 characters\]$/
    );
  });

  test('reports a response other than 200', async () => {
    const url = `${base}/missing`;

    assert.equal(
      await handler({ url }),
      `Got a 404 response when fetching ${url}`
    );
  });
});
