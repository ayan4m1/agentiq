import { join } from 'node:path';
import { glob, readFile, stat } from 'node:fs/promises';

import { getLogger } from '../modules/logging';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('find');

// directories whose contents are never what the model is looking for - a single
// unfiltered glob over node_modules returns tens of thousands of paths
const exclude = [
  '**/node_modules/**',
  '**/.git/**',
  '**/lib/**',
  '**/.yarn/**'
];

// an unbounded search is its own context bomb, so cap files and matches
const maxFiles = 100;
const maxMatches = 200;

export const definition = makeTool(
  'find',
  'Finds files by name pattern, and optionally searches their contents',
  [
    makeParameter(
      'string',
      'pattern',
      'Glob pattern matching file paths, e.g. "**/*.ts" or "src/**/tool*"'
    ),
    makeParameter(
      'string',
      'path',
      'Directory to search in - defaults to the working directory',
      false
    ),
    makeParameter(
      'string',
      'content',
      'Regular expression to search for inside the matched files. Omit to list filenames only',
      false
    ),
    makeParameter(
      'boolean',
      'caseInsensitive',
      'Whether to ignore case when matching content',
      false
    )
  ]
);

type Args = {
  pattern: string;
  path?: string;
  content?: string;
  caseInsensitive?: boolean;
};

export const handler = async ({
  pattern,
  path,
  content,
  caseInsensitive
}: Args) => {
  const cwd = path || process.cwd();
  const paths: string[] = [];
  let truncatedFiles = false;

  for await (const match of glob(pattern, { cwd, exclude })) {
    // glob yields directories too, and reading one throws EISDIR
    try {
      if (!(await stat(join(cwd, match))).isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    paths.push(match);

    if (paths.length >= maxFiles) {
      truncatedFiles = true;
      break;
    }
  }

  log.info(`Matched ${paths.length} files for ${pattern} in ${cwd}`);

  if (!paths.length) {
    return `No files matched ${pattern} in ${cwd}`;
  }

  if (!content) {
    return [
      `${paths.length} file(s) matching ${pattern} in ${cwd}:`,
      ...paths,
      truncatedFiles
        ? `[truncated at ${maxFiles} files - narrow the pattern]`
        : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  const contentPattern = new RegExp(content, caseInsensitive ? 'i' : '');
  const matches: string[] = [];
  let truncatedMatches = false;

  for (const filePath of paths) {
    let lines: string[];

    // a binary file read as utf-8 is garbage rather than an error, but it will
    // not match a sensible regex either - skipping unreadable files is enough
    try {
      lines = (await readFile(join(cwd, filePath), 'utf-8')).split('\n');
    } catch {
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      if (!contentPattern.test(lines[i])) {
        continue;
      }

      matches.push(`${filePath}:${i + 1}:${lines[i].trim()}`);

      if (matches.length >= maxMatches) {
        truncatedMatches = true;
        break;
      }
    }

    if (truncatedMatches) {
      break;
    }
  }

  log.info(`Found ${matches.length} lines matching ${content}`);

  if (!matches.length) {
    return `Searched ${paths.length} file(s) matching ${pattern}; nothing matched ${content}`;
  }

  return [
    `${matches.length} match(es) for ${content} in ${pattern}:`,
    ...matches,
    truncatedMatches
      ? `[truncated at ${maxMatches} matches - narrow the search]`
      : ''
  ]
    .filter(Boolean)
    .join('\n');
};
