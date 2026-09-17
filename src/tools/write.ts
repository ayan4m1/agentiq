import chalk from 'chalk';
import { existsSync, writeFileSync } from 'node:fs';

import { getLogger } from '../modules/logging';
import {
  describeDenial,
  isPlanning,
  requestApproval
} from '../modules/approval';
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
  if (isPlanning()) {
    return 'Plan mode is active, so no files can be written. Use the present_plan tool to propose an approach and ask to start work.';
  }

  console.log(`\n${chalk.bgGreen(content.replace(/\n{2,}/, '\n'))}\n`);

  const { approved, reason } = await requestApproval(
    `OK to ${existsSync(path) ? 'OVERWRITE' : 'write'} ${content.length} bytes to ${path}?`
  );

  if (!approved) {
    return describeDenial(`write ${path}`, reason);
  }

  writeFileSync(path, content);
  log.info('Wrote file!');

  return `Wrote ${content.length} bytes to ${path}`;
};
