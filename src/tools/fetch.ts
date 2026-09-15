import { getLogger } from '../modules/logging';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('fetch');

export const definition = makeTool('fetch', 'Fetches a document via HTTP', [
  makeParameter('string', 'url', 'The URL to fetch')
]);

type Args = {
  url: string;
};

export const handler = async ({ url }: Args) => {
  log.info(`Fetching URL ${url}`);

  const response = await fetch(url);

  if (response.status !== 200) {
    const message = `Got a ${response.status} response when fetching ${url}`;

    log.warn(message);

    return message;
  }

  return await response.text();
};
