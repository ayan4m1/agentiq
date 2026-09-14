import { confirm } from '@inquirer/prompts';
import { existsSync, writeFileSync } from 'node:fs';

import { makeParameter, makeTool } from '../utils';

export const definition = makeTool('write', 'Writes a new document', [
  makeParameter('string', 'path', 'Path to the document to write', true),
  makeParameter('string', 'content', 'Content to write to the document', true)
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
  }
};
