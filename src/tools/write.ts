import chalk from 'chalk';
import { existsSync, writeFileSync } from 'node:fs';

import { record } from '../modules/checkpoints';
import { getLogger } from '../modules/logging';
import {
  describeDenial,
  refusePlanning,
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

// small models often JSON-encode the content twice, so every line break lands
// as a literal \n. content with escaped line breaks but not one real one can
// only have been meant one way, so decode it - anything with a real line break
// is taken as written, since its escapes are presumably intended
export const unescapeContent = (content: string) => {
  if (/[\r\n]/.test(content) || !content.includes('\\n')) {
    return content;
  }

  // double encoding means quotes and backslashes came escaped as well, and
  // JSON.parse undoes all of it at once
  try {
    const decoded = JSON.parse(`"${content}"`);

    if (typeof decoded === 'string') {
      return decoded;
    }
  } catch {
    // not valid as a JSON string body, so fall back to the line breaks alone
  }

  return content
    .replace(/\\r\\n/g, '\r\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
};

export const handler = async ({ path, content: raw }: Args) => {
  const refusal = refusePlanning('no files can be written');

  if (refusal) {
    return refusal;
  }

  const content = unescapeContent(raw);

  console.log(`\n${chalk.green(content.replace(/\n{2,}/g, '\n'))}\n`);

  const { approved, reason } = await requestApproval(
    `OK to ${existsSync(path) ? 'OVERWRITE' : 'write'} ${content.length} bytes to ${path}?`,
    { kind: 'path', value: path }
  );

  if (!approved) {
    return describeDenial(`write ${path}`, reason);
  }

  // after approval and before the write, so /undo can put back whatever was
  // there - including nothing, when this is a new file
  record(path);
  writeFileSync(path, content);
  log.info('Wrote file!');

  return `Wrote ${content.length} bytes to ${path}`;
};
