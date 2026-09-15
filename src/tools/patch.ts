import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { getLogger } from '../modules/logging';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('patch');

export const definition = makeTool('patch', 'Patches an existing document', [
  makeParameter('string', 'path', 'Path to the document to patch'),
  makeParameter(
    'string',
    'regex',
    'Regular expression matching the text to replace'
  ),
  makeParameter('string', 'replacement', 'Text to substitute for each match'),
  makeParameter(
    'boolean',
    'global',
    'Whether or not to replace all instances of the search regex'
  ),
  makeParameter(
    'boolean',
    'caseInsensitive',
    'Whether or not to respect case for the replacement',
    false
  )
]);

type Args = {
  path: string;
  regex: string;
  replacement: string;
  global?: boolean;
  caseInsensitive?: boolean;
};

export const handler = async ({
  caseInsensitive,
  global,
  path,
  regex,
  replacement
}: Args) => {
  if (!existsSync(path)) {
    return `Cannot replace text in ${path} - it does not exist`;
  }

  log.info(`Replacing ${regex} with ${replacement} in ${path}`);

  let regexOpts = '';

  if (global) {
    regexOpts += 'g';
  }

  if (caseInsensitive) {
    regexOpts += 'i';
  }

  const contents = readFileSync(path).toString();
  const pattern = new RegExp(regex, regexOpts);
  const replaced = contents.replace(pattern, replacement);

  if (contents === replaced) {
    return 'The regex did not match; no change was made.';
  }

  console.log(chalk.bgRed.black(contents));
  console.log(chalk.bgGreen.black(replaced));

  const { proceed } = await inquirer.prompt({
    type: 'confirm',
    name: 'proceed',
    message: `OK to write ${replaced.length} bytes to ${path}?`,
    default: false
  });

  if (proceed) {
    writeFileSync(path, replaced);
    log.info('Wrote file!');

    return { contents, newContents: replaced };
  } else {
    return 'The user declined to make the change.';
  }
};
