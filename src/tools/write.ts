import chalk from 'chalk';
import { existsSync, writeFileSync } from 'node:fs';

import { getLogger } from '../modules/logging';
import { isPlanning, requestApproval } from '../modules/approval';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('write');

export const definition = makeTool('write', 'Writes a new document', [
  makeParameter('string', 'path', 'Path to the document to write'),
  makeParameter('string', 'content', 'Content to write to the document')
]);

type Args = {
  path: string;
  content: string;
};

export const handler = async ({ path, content }: Args) => {
  if (existsSync(path)) {
    return 'The path already exists - use the patch tool to modify it.';
  }

  if (isPlanning()) {
    return 'Plan mode is active, so no files can be written. Use the present_plan tool to propose an approach and ask to start work.';
  }

  console.log(`\n\n${chalk.bgGreen.black(content)}\n\n`);

  if (
    await requestApproval(`OK to write ${content.length} bytes to ${path}?`)
  ) {
    writeFileSync(path, content);
    log.info('Wrote file!');

    return `Wrote ${content.length} bytes to ${path}`;
  } else {
    return 'User declined to write file.';
  }
};
