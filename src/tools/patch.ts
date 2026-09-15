import { confirm } from '@inquirer/prompts';
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
    'caseInsensitive',
    'Whether or not to respect case for the replacement',
    false
  )
]);

type Args = {
  path: string;
  regex: string;
  replacement: string;
  caseInsensitive?: boolean;
};

export const handler = async ({
  path,
  regex,
  replacement,
  caseInsensitive
}: Args) => {
  if (!existsSync(path)) {
    log.error(`Cannot replace text in ${path} - it does not exist`);
    return;
  }

  log.info(`Replacing ${regex} with ${replacement} in ${path}`);

  const contents = readFileSync(path).toString();
  const pattern = new RegExp(regex, caseInsensitive ? 'gi' : 'g');
  const replaced = contents.replace(pattern, replacement);

  const proceed = await confirm({
    message: `OK to write ${replaced.length} bytes to ${path}?`,
    default: false
  });

  if (proceed) {
    writeFileSync(path, replaced);
    log.info('Wrote file!');
  }

  return { contents, newContents: replaced };
};
