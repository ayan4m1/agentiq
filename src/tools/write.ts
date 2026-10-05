import chalk from 'chalk';
import { extname } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

import { record } from '../modules/checkpoints';
import { getLogger } from '../modules/logging';
import {
  describeDenial,
  refusePlanning,
  requestApproval
} from '../modules/approval';
import { describeDiff, makeParameter, makeTool, truncate } from '../utils';

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

// what the model is told when the user rewrote its proposal: only the changes,
// since it already knows what it sent. it has to hear about them, or its next
// patch will be aimed at text that is no longer there
export const describeEdit = (path: string, proposed: string, edited: string) =>
  `The user edited it before approving - their changes to what you proposed:\n${truncate(
    describeDiff(path, proposed, edited)
  )}`;

export const handler = async ({ path, content: raw }: Args) => {
  const refusal = refusePlanning('no files can be written');

  if (refusal) {
    return refusal;
  }

  const content = unescapeContent(raw);
  const verb = existsSync(path) ? 'OVERWRITE' : 'write';

  // the preview and the question both come round again after an edit
  const show = (text: string) => {
    console.log(`\n${chalk.green(text.replace(/\n{2,}/g, '\n'))}\n`);

    return `OK to ${verb} ${text.length} bytes to ${path}?`;
  };

  const { approved, reason, edited } = await requestApproval(
    show(content),
    { kind: 'path', value: path },
    { content, extension: extname(path) || '.txt', show }
  );

  if (!approved) {
    return describeDenial(`write ${path}`, reason);
  }

  const written = edited ?? content;

  // after approval and before the write, so /undo can put back whatever was
  // there - including nothing, when this is a new file
  record(path);
  writeFileSync(path, written);
  log.info('Wrote file!');

  const result = `Wrote ${written.length} bytes to ${path}`;

  return edited === undefined
    ? result
    : `${result}. ${describeEdit(path, content, edited)}`;
};
