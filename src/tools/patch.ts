import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { makeParameter, makeTool } from '../utils';
import { confirm } from '@inquirer/prompts';

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

type IArgs = {
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
}: IArgs) => {
  if (!existsSync(path)) {
    return;
  }

  const contents = readFileSync(path).toString();
  const pattern = new RegExp(regex, caseInsensitive ? 'gi' : 'g');
  const replaced = contents.replace(pattern, replacement);

  const proceed = await confirm({
    message: `OK to write ${replaced} bytes to ${path}?`
  });

  if (proceed) {
    writeFileSync(path, replaced);
  }

  return JSON.stringify({ contents, newContents: replaced });
};
