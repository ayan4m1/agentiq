import { makeParameter, makeTool } from '../utils';

export const definition = makeTool('fetch', 'Fetches a document via HTTP', [
  makeParameter('string', 'url', 'The URL to fetch')
]);

type IArgs = {
  url: string;
};

export const handler = async ({ url }: IArgs) => {
  const response = await fetch(url);

  if (response.status !== 200) {
    console.warn(`Got ${response.status} response when fetching ${url}`);
    return;
  }

  const contents = await response.text();

  return JSON.stringify({ contents });
};
