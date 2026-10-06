import Ceramic from 'ceramic-ai';

import { ceramic } from '../modules/config';
import { getLogger } from '../modules/logging';
import { turn } from '../modules/turn';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('search');
const maxResults = 10;

export const definition = makeTool(
  'search',
  'Search the Web for a specific query',
  [makeParameter('string', 'query', 'The search query', true)]
);

type Args = {
  query: string;
};

// built on first use rather than at import - the SDK throws on a missing key,
// and this module is imported whether or not the tool is offered
let client: Ceramic | undefined;

export const handler = async ({ query }: Args) => {
  const limit = ceramic.perTurnLimit;

  // refused before the request rather than after, so a refusal costs nothing.
  // a failed search still counts - it was still a request
  if (limit > 0 && turn.searches >= limit) {
    const message = `Not searching for "${query}" - the limit of ${limit} searches per message has been reached. Work with the results you already have.`;

    log.warn(message);

    return message;
  }

  turn.searches++;

  log.info(`Searching for ${query}`);

  try {
    client ??= new Ceramic({ apiKey: ceramic.apiKey });

    const { result } = await client.search({ query, maxResults });
    // the API is asked for no more than this, but is not trusted to listen
    const results = result.results.slice(0, maxResults);

    // tool results arrive with no record of the call that produced them, so
    // say which query this is
    if (!results.length) {
      return `No results for "${query}"`;
    }

    const markdown = results
      .map((hit) => `- [${hit.title}](${hit.url}) - ${hit.description}`)
      .join('\n');

    return `Got ${results.length} results for "${query}":\n\n${markdown}`;
  } catch (error) {
    const message =
      error instanceof Error
        ? `The search failed with error: ${error.message}`
        : 'The search failed.';

    log.warn(message);

    return message;
  }
};
