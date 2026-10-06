import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// the character budget is sized from the context limit when the module is
// evaluated, so shrink it first - 100 tokens is a budget of 99 characters
process.env.AQ_CONTEXT_LIMIT = '100';

const { handler } = await import('./fetch');

// the smallest PDF pdf.js will read - one page per entry, each drawing its text
// in Helvetica, or nothing at all for an empty string
const makePdf = (texts: string[]) => {
  const pageIds = texts.map((_, index) => 4 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...texts.flatMap((text, index) => {
      const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';

      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
      ];
    })
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;

    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;

    return offset;
  });
  const xref = pdf.length;

  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
};

const twoPages = makePdf(['Alpha', 'Bravo']);

const pages: Record<string, { type?: string; body: string | Buffer }> = {
  '/doc.pdf': { type: 'application/pdf', body: twoPages },
  '/broken.pdf': {
    type: 'application/pdf',
    body: '%PDF-1.4\nnot really a pdf'
  },
  '/huge.pdf': {
    type: 'application/pdf',
    // a narrow glyph, since pdf.js drops text that runs off the page
    body: makePdf(['i'.repeat(150)])
  },
  '/untyped': { body: 'no type' },
  '/nul-text': { type: 'text/plain', body: 'a\0b' },
  '/download': { type: 'application/octet-stream', body: twoPages },
  '/many.pdf': {
    type: 'application/pdf',
    body: makePdf(['One', 'Two', 'Three', 'Four', 'Five'])
  },
  '/scanned.pdf': { type: 'application/pdf', body: makePdf(['', '']) },
  '/image': {
    type: 'image/png',
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
  },
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

    response
      .writeHead(200, page.type ? { 'content-type': page.type } : {})
      .end(page.body);
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

  test('extracts the text of a PDF page by page', async () => {
    const url = `${base}/doc.pdf`;

    assert.equal(
      await handler({ url }),
      `Fetched ${url} (application/pdf, ${twoPages.length} bytes, 2 pages)\n\n--- page 1 of 2 ---\nAlpha\n\n--- page 2 of 2 ---\nBravo`
    );
  });

  test('recognizes a PDF that is not labelled as one', async () => {
    assert.match(
      await handler({ url: `${base}/download` }),
      /--- page 1 of 2 ---\nAlpha/
    );
  });

  test('returns only the pages asked for', async () => {
    assert.match(
      await handler({ url: `${base}/doc.pdf`, pages: '2' }),
      /pages\)\n\n--- page 2 of 2 ---\nBravo$/
    );
  });

  test('stops a PDF on a page boundary and says how to get the rest', async () => {
    const result = await handler({ url: `${base}/many.pdf` });

    assert.match(
      result,
      /--- page 3 of 5 ---\nThree\n\n\[showing pages 1-3 of 5 - fetch again with pages "4-5" for more\]$/
    );
  });

  test('refuses a page range outside the document', async () => {
    assert.match(
      await handler({ url: `${base}/doc.pdf`, pages: '7-9' }),
      /Cannot read pages "7-9" - the document has pages 1-2$/
    );
  });

  test('refuses a page range it cannot read', async () => {
    assert.match(
      await handler({ url: `${base}/doc.pdf`, pages: 'abc' }),
      /Cannot read pages "abc" - the document has pages 1-2$/
    );
  });

  test('refuses a page range that runs backwards', async () => {
    assert.match(
      await handler({ url: `${base}/doc.pdf`, pages: '2-1' }),
      /Cannot read pages "2-1" - the document has pages 1-2$/
    );
  });

  test('treats page 0 as the first page', async () => {
    assert.match(
      await handler({ url: `${base}/doc.pdf`, pages: '0-1' }),
      /pages\)\n\n--- page 1 of 2 ---\nAlpha$/
    );
  });

  test('shows part of a single page too long for the budget', async () => {
    const result = await handler({ url: `${base}/huge.pdf` });

    assert.match(result, /1 pages\)\n\n--- page 1 of 1 ---\ni+\n/);
    assert.match(result, /\[truncated: showing 99 of 170 characters\]$/);
    assert.doesNotMatch(result, /\[showing pages/);
  });

  test('says when a PDF cannot be read', async () => {
    const url = `${base}/broken.pdf`;
    const result = await handler({ url });

    assert.match(result, /\n\nCould not read the PDF: .+$/);
    assert.ok(
      result.startsWith(`Fetched ${url} (application/pdf, 25 bytes)\n\n`)
    );
  });

  test('says when a PDF has no text to extract', async () => {
    assert.match(
      await handler({ url: `${base}/scanned.pdf` }),
      /\[this PDF has no extractable text - it is likely scanned images\]$/
    );
  });

  test('withholds binary content', async () => {
    const url = `${base}/image`;

    assert.equal(
      await handler({ url }),
      `Fetched ${url} (image/png, 10 bytes)\n\n[binary content not shown]`
    );
  });

  test('passes text through even when it contains a NUL', async () => {
    assert.match(await handler({ url: `${base}/nul-text` }), /\n\na\0b$/);
  });

  test('says when the content type is unknown', async () => {
    const url = `${base}/untyped`;

    assert.equal(
      await handler({ url }),
      `Fetched ${url} (unknown, 7 bytes)\n\nno type`
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
