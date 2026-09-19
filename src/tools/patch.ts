import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { record } from '../modules/checkpoints';
import { getLogger } from '../modules/logging';
import {
  describeDenial,
  refusePlanning,
  requestApproval
} from '../modules/approval';
import { makeParameter, makeTool, renderDiff } from '../utils';

const log = getLogger('patch');

export const definition = makeTool(
  'patch',
  'Replaces exact snippets of text in an existing document. Pass oldText and newText for a single replacement, or edits for several in one pass - a batch is read, previewed and confirmed once, and applied all or not at all',
  [
    makeParameter('string', 'path', 'Path to the document to patch'),
    makeParameter(
      'string',
      'oldText',
      'The exact text to replace, copied verbatim from the document. Include enough surrounding text to make it unique',
      false
    ),
    makeParameter('string', 'newText', 'The text to put in its place', false),
    makeParameter(
      'boolean',
      'replaceAll',
      'Whether to replace every occurrence instead of requiring a unique match',
      false
    ),
    makeParameter(
      'array',
      'edits',
      'Several replacements to make in one pass, each an object with oldText and newText, and optionally replaceAll. They are applied in order, so a later one sees what the earlier ones changed. Use this instead of oldText and newText, not as well as',
      false,
      'object'
    )
  ]
);

type Edit = {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

type Args = {
  path: string;
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  edits?: unknown[];
};

// exported for tests: this count is what decides between a clean replace, a
// refusal, and a replaceAll, so its non-overlapping behaviour matters
export const countOccurrences = (haystack: string, needle: string) => {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
};

// validation only checks that the entries are objects - what is inside one is
// this tool's business, and a malformed entry has to come back as something
// the model can correct rather than as a crash
const readEdit = (entry: unknown, index: number): Edit | string => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return `Entry ${index + 1} of edits is not an object with oldText and newText.`;
  }

  const { oldText, newText, replaceAll } = entry as Record<string, unknown>;

  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    return `Entry ${index + 1} of edits needs both oldText and newText, as strings.`;
  }

  return { oldText, newText, replaceAll: replaceAll === true };
};

// one shape for the rest of the tool to work with, whichever way it was asked
export const collectEdits = ({
  oldText,
  newText,
  replaceAll,
  edits
}: Omit<Args, 'path'>): Edit[] | string => {
  if (edits?.length) {
    const collected: Edit[] = [];

    for (const [index, entry] of edits.entries()) {
      const edit = readEdit(entry, index);

      if (typeof edit === 'string') {
        return edit;
      }

      collected.push(edit);
    }

    return collected;
  }

  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    return 'Call patch with oldText and newText for a single replacement, or with edits for several.';
  }

  return [{ oldText, newText, replaceAll: replaceAll === true }];
};

// applies every edit to the text in memory, refusing the whole batch the
// moment one of them cannot be placed. nothing reaches disk until they have
// all succeeded, so a half-applied set of edits is not a state that exists
export const applyEdits = (
  contents: string,
  edits: Edit[],
  path: string
): { text: string; replacements: number } | string => {
  let text = contents;
  let replacements = 0;

  for (const [index, edit] of edits.entries()) {
    const occurrences = countOccurrences(text, edit.oldText);
    // which edit failed is the first thing worth knowing about a batch
    const which =
      edits.length > 1 ? ` (edit ${index + 1} of ${edits.length})` : '';

    if (!occurrences) {
      log.debug('Patch oldText does not appear in document');

      return `That text does not appear in ${path}${which}; no change was made. Read the file again and copy the snippet exactly.`;
    }

    // replacing the wrong one of several identical snippets is a silent
    // corruption, so make the model disambiguate rather than guessing for it
    if (occurrences > 1 && !edit.replaceAll) {
      log.debug('Require only one match for it to work');

      return `That text appears ${occurrences} times in ${path}${which}; no change was made. Include more surrounding context to identify a single occurrence, or set replaceAll to true.`;
    }

    // split and join rather than replace: String.replace reads $& and $1 in
    // the replacement as instructions, which would quietly mangle any code
    // that happens to contain them. with a single occurrence the two are
    // otherwise the same thing
    text = text.split(edit.oldText).join(edit.newText);
    replacements += occurrences;
  }

  return { text, replacements };
};

export const handler = async ({
  path,
  oldText,
  newText,
  replaceAll,
  edits
}: Args) => {
  // plan mode first, as in every other mutating tool - in a mode that refuses
  // the call outright there is no reason to go to disk at all
  const refusal = refusePlanning('no files can be changed');

  if (refusal) {
    return refusal;
  }

  const requested = collectEdits({ oldText, newText, replaceAll, edits });

  if (typeof requested === 'string') {
    return requested;
  }

  if (!existsSync(path)) {
    log.debug('Path does not exist');
    return `Cannot replace text in ${path} - it does not exist`;
  }

  const contents = readFileSync(path).toString();
  const applied = applyEdits(contents, requested, path);

  if (typeof applied === 'string') {
    return applied;
  }

  log.info(
    `Applying ${requested.length} edit(s) making ${applied.replacements} replacement(s) in ${path}`
  );

  // one diff and one prompt for the whole batch: approving five edits one at a
  // time is what makes a five-part change cost five round trips
  renderDiff(path, contents, applied.text);

  const { approved, reason } = await requestApproval(
    `OK to write ${applied.text.length} bytes to ${path}?`,
    { kind: 'path', value: path }
  );

  if (!approved) {
    return describeDenial(`change ${path}`, reason);
  }

  record(path);
  writeFileSync(path, applied.text);
  log.info(`Wrote to ${path}!`);

  // returning the file bodies here would hand the model the whole document
  // twice over - it already knows what it asked for
  return `Replaced ${applied.replacements} occurrence(s) in ${path}`;
};
