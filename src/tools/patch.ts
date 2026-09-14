import { existsSync, readFileSync } from 'node:fs';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool('patch', 'Patches an existing document', [
  makeParameter('string', 'path', 'Path to the document to patch', true),
  makeParameter(
    'string',
    'regex',
    'Regular expression matching the text to replace',
    true
  ),
  makeParameter(
    'string',
    'replacement',
    'Text to substitute for each match',
    true
  ),
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

  contents.replace(pattern, replacement);
};
