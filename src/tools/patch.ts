import chalk from 'chalk';
import { structuredPatch } from 'diff';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { getLogger } from '../modules/logging';
import {
  describeDenial,
  isPlanning,
  requestApproval
} from '../modules/approval';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('patch');

export const definition = makeTool(
  'patch',
  'Replaces an exact snippet of text in an existing document',
  [
    makeParameter('string', 'path', 'Path to the document to patch'),
    makeParameter(
      'string',
      'oldText',
      'The exact text to replace, copied verbatim from the document. Include enough surrounding lines to make it unique'
    ),
    makeParameter('string', 'newText', 'The text to put in its place'),
    makeParameter(
      'boolean',
      'replaceAll',
      'Whether to replace every occurrence instead of requiring a unique match',
      false
    )
  ]
);

type Args = {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

const countOccurrences = (haystack: string, needle: string) => {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
};

// the whole file on a colored background buries the change it is meant to show,
// so render only the hunks the patch actually touches
const renderDiff = (path: string, before: string, after: string) => {
  const { hunks } = structuredPatch(path, path, before, after, '', '', {
    context: 3
  });

  for (const hunk of hunks) {
    console.log(
      chalk.cyan(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
      )
    );

    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red(line));
      } else {
        console.log(chalk.dim(line));
      }
    }
  }
};

export const handler = async ({ path, oldText, newText, replaceAll }: Args) => {
  if (!existsSync(path)) {
    return `Cannot replace text in ${path} - it does not exist`;
  }

  if (isPlanning()) {
    return 'Plan mode is active, so no files can be changed. Use the present_plan tool to propose an approach and ask to start work.';
  }

  const contents = readFileSync(path).toString();
  const occurrences = countOccurrences(contents, oldText);

  if (!occurrences) {
    return `That text does not appear in ${path}; no change was made. Read the file again and copy the snippet exactly.`;
  }

  // replacing the wrong one of several identical snippets is a silent
  // corruption, so make the model disambiguate rather than guessing for it
  if (occurrences > 1 && !replaceAll) {
    return `That text appears ${occurrences} times in ${path}; no change was made. Include more surrounding context to identify a single occurrence, or set replaceAll to true.`;
  }

  log.info(
    `Replacing ${occurrences} occurrence(s) of ${oldText.length} bytes in ${path}`
  );

  const replaced = replaceAll
    ? contents.split(oldText).join(newText)
    : contents.replace(oldText, newText);

  renderDiff(path, contents, replaced);

  const { approved, reason } = await requestApproval(
    `OK to write ${replaced.length} bytes to ${path}?`
  );

  if (!approved) {
    return describeDenial(`change ${path}`, reason);
  }

  writeFileSync(path, replaced);
  log.info(`Wrote to ${path}!`);

  // returning the file bodies here would hand the model the whole document
  // twice over - it already knows what it asked for
  return `Replaced ${occurrences} occurrence(s) in ${path}`;
};
