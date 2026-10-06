import { parse } from 'node-html-parser';
import { extractText, getDocumentProxy } from 'unpdf';

import { getLogger } from '../modules/logging';
import {
  describeError,
  getContentBudget,
  makeParameter,
  makeTool,
  truncate
} from '../utils';

const log = getLogger('fetch');
const maxLength = getContentBudget();

export const definition = makeTool('fetch', 'Fetches a document via HTTP', [
  makeParameter('string', 'url', 'The URL to fetch'),
  makeParameter(
    'string',
    'pages',
    'For PDFs only: the page or range of pages to return, e.g. "5" or "5-12". Defaults to as many pages from the start as fit',
    false
  )
]);

type Args = {
  url: string;
  pages?: string;
};

// an HTML document is mostly markup the model has no use for - scripts, styles
// and attributes crowd out the prose and can account for 90% of the payload.
// the doctype goes first because the parser would otherwise emit it as text.
const stripHtml = (html: string) => {
  const root = parse(html.replace(/<!DOCTYPE[^>]*>/i, ''));

  for (const node of root.querySelectorAll('script, style, noscript')) {
    node.remove();
  }

  return root.structuredText.replace(/\n{3,}/g, '\n\n').trim();
};

// servers often label a PDF application/octet-stream, so trust the magic bytes
// as much as the header
const isPdf = (contentType: string, body: Buffer) =>
  contentType.includes('pdf') ||
  body.subarray(0, 5).toString('latin1') === '%PDF-';

// decoding binary as UTF-8 hands the model a budget's worth of mojibake, so a
// body that is not labelled as text and has a NUL near its start is withheld
const textTypes = /^text\/|json|xml|javascript/;

const isBinary = (contentType: string, body: Buffer) =>
  !textTypes.test(contentType) && body.subarray(0, 1024).includes(0);

// "5" or "5-12", clamped to the document - undefined when it cannot be read
const parseRange = (pages: string, total: number) => {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(pages);

  if (!match) {
    return undefined;
  }

  const first = Math.max(Number(match[1]), 1);
  const last = Math.min(Number(match[2] ?? match[1]), total);

  return first <= last ? { first, last } : undefined;
};

// the text of a PDF a page at a time, stopping on a page boundary rather than
// mid-page so the model can ask for exactly the pages it has not seen yet
const describePdf = async (header: string, body: Buffer, pages?: string) => {
  let extracted: { totalPages: number; text: string[] };

  try {
    extracted = await extractText(await getDocumentProxy(new Uint8Array(body)));
  } catch (error) {
    return `${header}\n\nCould not read the PDF: ${describeError(error)}`;
  }

  const { totalPages, text } = extracted;
  const pdfHeader = `${header.slice(0, -1)}, ${totalPages} pages)`;

  if (text.every((page) => !page.trim())) {
    return `${pdfHeader}\n\n[this PDF has no extractable text - it is likely scanned images]`;
  }

  const range = pages
    ? parseRange(pages, totalPages)
    : { first: 1, last: totalPages };

  if (!range) {
    return `${pdfHeader}\n\nCannot read pages "${pages}" - the document has pages 1-${totalPages}`;
  }

  const shown: string[] = [];
  let used = 0;
  let last = range.first - 1;

  for (let page = range.first; page <= range.last; page++) {
    const entry = `--- page ${page} of ${totalPages} ---\n${text[page - 1].trim()}`;

    if (used + entry.length > maxLength) {
      // a single page over the budget is still worth showing in part
      if (!shown.length) {
        shown.push(truncate(entry, maxLength));
        last = page;
      }

      break;
    }

    shown.push(entry);
    used += entry.length + 2;
    last = page;
  }

  const content = shown.join('\n\n');

  if (last < range.last) {
    const next = `${last + 1}-${range.last}`;

    log.warn(`Showing pages ${range.first}-${last} of ${totalPages}`);

    return `${pdfHeader}\n\n${content}\n\n[showing pages ${range.first}-${last} of ${totalPages} - fetch again with pages "${next}" for more]`;
  }

  return `${pdfHeader}\n\n${content}`;
};

export const handler = async ({ url, pages }: Args) => {
  log.info(`Fetching URL ${url}`);

  const response = await fetch(url, {
    headers: {
      // lowest effort anti-anti-scraping
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0'
    }
  });

  if (response.status !== 200) {
    const message = `Got a ${response.status} response when fetching ${url}`;

    log.warn(message);

    return message;
  }

  const contentType = response.headers.get('content-type') ?? 'unknown';
  const body = Buffer.from(await response.arrayBuffer());
  const byteCount = body.length;
  // tool results arrive with no record of the call that produced them, so say
  // which URL this is and how many bytes were returned
  const header = `Fetched ${url} (${contentType}, ${byteCount} bytes)`;

  if (isPdf(contentType, body)) {
    log.info(`Read ${byteCount} bytes of PDF from ${url}`);

    return describePdf(header, body, pages);
  }

  if (isBinary(contentType, body)) {
    log.info(`Read ${byteCount} bytes of binary from ${url}`);

    return `${header}\n\n[binary content not shown]`;
  }

  const content = contentType.includes('html')
    ? stripHtml(body.toString())
    : body.toString();

  log.info(
    `Read ${byteCount} bytes from ${url} - ${content.length} characters after stripping`
  );

  if (content.length > maxLength) {
    log.warn(`Truncating ${url} to ${maxLength} characters`);
  }

  return `${header}\n\n${truncate(content, maxLength)}`;
};
