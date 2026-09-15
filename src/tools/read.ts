import { existsSync, readFileSync } from 'node:fs';

import { getLogger } from '../modules/logging';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('read');

export const definition = makeTool('read', 'Reads an existing document', [
  makeParameter('string', 'path', 'Path to the document to read')
]);

type Args = {
  path: string;
};

export const handler = async ({ path }: Args) => {
  if (!existsSync(path)) {
    log.error(`Cannot read ${path} - it does not exist`);
    return;
  }

  const contents = readFileSync(path).toString();

  log.info(`Read ${contents.length} bytes from ${path}`);

  return contents;
};
