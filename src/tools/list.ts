import { filesize } from 'filesize';
import { join, resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

import { getLogger } from '../modules/logging';
import { gitVisible, toPosix, visibleDirectories } from '../modules/ignore';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('list');

// the same guard the find tool applies, by name rather than by glob since
// entries are examined one at a time here
const skip = new Set(['node_modules', '.git', '.yarn']);
// an unbounded listing of a large tree is its own context bomb
const maxEntries = 300;
const indent = '  ';

export const definition = makeTool(
  'list',
  'Lists what is in a directory. Use this to get your bearings in an unfamiliar project before reaching for find',
  [
    makeParameter(
      'string',
      'path',
      'Directory to list - defaults to the working directory',
      false
    ),
    makeParameter(
      'number',
      'depth',
      'How many levels to descend. Defaults to 1, which lists only the directory itself',
      false
    )
  ]
);

type Args = {
  path?: string;
  depth?: number;
};

type Entry = {
  line: string;
  directory: boolean;
};

export const handler = async ({ path, depth }: Args) => {
  const root = path ? resolve(path) : process.cwd();
  const levels = Math.max(depth ?? 1, 1);
  const visible = gitVisible(root);
  const directories = visible ? visibleDirectories(visible) : undefined;
  const lines: string[] = [];
  let truncated = false;
  let count = 0;

  // breadth of a directory before depth of the next, so a shallow listing is
  // complete rather than a single deep branch
  const walk = async (directory: string, relative: string, level: number) => {
    if (level > levels || truncated) {
      return;
    }

    let found;

    try {
      found = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // a directory that cannot be read is worth saying so about, once
      lines.push(`${indent.repeat(level - 1)}[unreadable: ${relative || '.'}]`);
      log.debug(`Could not read ${directory}: ${String(error)}`);

      return;
    }

    const entries: Entry[] = [];
    const descend: { path: string; relative: string; name: string }[] = [];

    for (const item of found.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (skip.has(item.name)) {
        continue;
      }

      const childRelative = relative ? `${relative}/${item.name}` : item.name;
      const childPath = join(directory, item.name);

      if (item.isDirectory()) {
        // a directory holding nothing git will show is not part of the project
        if (directories && !directories.has(childRelative)) {
          continue;
        }

        entries.push({ line: `${item.name}/`, directory: true });
        descend.push({
          path: childPath,
          relative: childRelative,
          name: item.name
        });

        continue;
      }

      if (visible && !visible.has(childRelative)) {
        continue;
      }

      let size = '';

      try {
        size = `  ${filesize((await stat(childPath)).size)}`;
      } catch {
        // a broken link or a file that went away mid-listing
        size = '';
      }

      entries.push({ line: `${item.name}${size}`, directory: false });
    }

    for (const entry of entries) {
      if (count >= maxEntries) {
        truncated = true;

        return;
      }

      lines.push(`${indent.repeat(level - 1)}${entry.line}`);
      count++;
    }

    for (const child of descend) {
      await walk(child.path, child.relative, level + 1);
    }
  };

  await walk(root, '', 1);

  log.info(`Listed ${count} entr(ies) under ${root}`);

  if (!count) {
    return `${toPosix(root)} is empty, or holds nothing that is not ignored`;
  }

  return [
    `${count} entr(ies) under ${toPosix(root)}:`,
    ...lines,
    truncated
      ? `[truncated at ${maxEntries} entries - list a subdirectory, or use find with a pattern]`
      : ''
  ]
    .filter(Boolean)
    .join('\n');
};
