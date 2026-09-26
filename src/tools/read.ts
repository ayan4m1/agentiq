import { existsSync, readFileSync, statSync } from 'node:fs';

import { getLogger } from '../modules/logging';
import { getContentBudget, makeParameter, makeTool } from '../utils';

const log = getLogger('read');
const maxLength = getContentBudget();

export const definition = makeTool(
  'read',
  'Reads an existing document, returning its contents with line numbers',
  [
    makeParameter('string', 'path', 'Path to the document to read'),
    makeParameter(
      'number',
      'offset',
      'Line number to start reading from, 1-based. Defaults to the first line',
      false
    ),
    makeParameter(
      'number',
      'limit',
      'Maximum number of lines to return. Defaults to as many as will fit',
      false
    )
  ]
);

type Args = {
  path: string;
  offset?: number;
  limit?: number;
};

// the tool's output, kept synchronous so a file the user mentions with @ can be
// attached to their message in exactly the form the model already knows
export const readFile = ({ path, offset, limit }: Args) => {
  if (!existsSync(path)) {
    return `Cannot read ${path} - it does not exist`;
  }

  // readFileSync throws EISDIR on a directory, which reaches the model as an
  // opaque errno - tell it to use the find tool instead
  if (statSync(path).isDirectory()) {
    return `${path} is a directory, not a file - use the find tool to list its contents`;
  }

  const lines = readFileSync(path).toString().split('\n');
  const start = Math.max((offset ?? 1) - 1, 0);

  if (start >= lines.length) {
    return `${path} has only ${lines.length} lines - offset ${offset} is past the end`;
  }

  const selected = lines.slice(start, limit ? start + limit : undefined);
  const numbered: string[] = [];
  let used = 0;

  // stop on the character budget rather than truncating mid-line, so every line
  // handed back is complete and its number is trustworthy
  for (const [index, line] of selected.entries()) {
    const entry = `${String(start + index + 1).padStart(6)}\t${line}`;

    if (used + entry.length > maxLength) {
      break;
    }

    numbered.push(entry);
    used += entry.length + 1;
  }

  const lastLine = start + numbered.length;

  log.info(
    `Read lines ${start + 1}-${lastLine} of ${lines.length} from ${path}`
  );

  const body = numbered.join('\n');

  if (lastLine < lines.length) {
    return `${body}\n\n[showing lines ${start + 1}-${lastLine} of ${lines.length} - call read again with offset ${lastLine + 1} for more]`;
  }

  return body;
};

export const handler = async (args: Args) => readFile(args);
