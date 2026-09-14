import { confirm } from '@inquirer/prompts';
import { existsSync, writeFileSync } from 'node:fs';

import { getLogger } from '../modules/logging';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('write');

export const definition = makeTool('write', 'Writes a new document', [
  makeParameter('string', 'path', 'Path to the document to write'),
  makeParameter('string', 'content', 'Content to write to the document')
]);

type IArgs = {
  path: string;
  content: string;
};

export const handler = async ({ path, content }: IArgs) => {
  if (existsSync(path)) {
    return;
  }

  const proceed = await confirm({
    message: `OK to write ${content.length} bytes to ${path}?`
  });

  if (proceed) {
    writeFileSync(path, content);
    log.info('Wrote file!');
  }
};
