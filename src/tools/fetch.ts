import { parse } from 'node-html-parser';

import { getLogger } from '../modules/logging';
import { getContentBudget, makeParameter, makeTool } from '../utils';

const log = getLogger('fetch');
const maxLength = getContentBudget();

export const definition = makeTool('fetch', 'Fetches a document via HTTP', [
  makeParameter('string', 'url', 'The URL to fetch')
]);

type Args = {
  url: string;
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

export const handler = async ({ url }: Args) => {
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
  const body = await response.text();
  const byteCount = Buffer.byteLength(body);
  const content = contentType.includes('html') ? stripHtml(body) : body;
  // tool results arrive with no record of the call that produced them, so say
  // which URL this is and how many bytes were returned
  const header = `Fetched ${url} (${contentType}, ${byteCount} bytes)`;

  log.info(
    `Read ${byteCount} bytes from ${url} - ${content.length} characters after stripping`
  );

  if (content.length > maxLength) {
    log.warn(`Truncating ${url} to ${maxLength} characters`);

    return `${header}\n\n${content.slice(0, maxLength)}\n\n[truncated: showing ${maxLength} of ${content.length} characters]`;
  }

  return `${header}\n\n${content}`;
};
