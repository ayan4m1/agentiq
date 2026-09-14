import { getLogger } from '../modules/logging';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('fetch');

export const definition = makeTool('fetch', 'Fetches a document via HTTP', [
  makeParameter('string', 'url', 'The URL to fetch')
]);

type IArgs = {
  url: string;
};

export const handler = async ({ url }: IArgs) => {
  log.info(`Fetching URL ${url}`);

  const response = await fetch(url);

  if (response.status !== 200) {
    log.warn(`Got ${response.status} response when fetching ${url}`);
    return;
  }

  return await response.text();
};
