import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, writeFileSync } from 'node:fs';

import { getLogger } from '../modules/logging';
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
    return 'The path already exists - use the patch tool instead.';
  }

  console.log(`\n\n${chalk.bgGreen.black(content)}\n\n`);

  const { proceed } = await inquirer.prompt({
    type: 'confirm',
    name: 'proceed',
    message: `OK to write ${content.length} bytes to ${path}?`,
    default: false
  });

  if (proceed) {
    writeFileSync(path, content);
    log.info('Wrote file!');

    return `Wrote ${content.length} bytes to ${path}`;
  } else {
    return 'User declined to write file.';
  }
};
