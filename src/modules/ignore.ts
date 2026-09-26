import { join, sep } from 'node:path';
import { globSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// directories whose contents are never what the model is looking for. this is
// as much a performance guard as a filter: a single unfiltered glob over
// node_modules returns tens of thousands of paths. note that build output is
// deliberately not here - whether lib/ holds sources or artefacts is a fact
// about the project, and git already knows which
export const alwaysExclude = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.yarn/**'
];

// the same directories by name, for a path that has already been listed
const excludedNames = new Set(['node_modules', '.git', '.yarn']);

const gitTimeout = 5000;
// a large repository lists a great many paths, and the default 1MB would cut
// the list off partway through - which would read as "these files do not exist"
const maxBuffer = 64 * 1024 * 1024;

// glob yields platform separators and git always answers with forward slashes,
// so one of them has to give
export const toPosix = (path: string) => path.split(sep).join('/');

// git already knows what is ignored: every nested .gitignore, the repository
// exclude file, and the user's global one, with all the anchoring and negation
// rules that go with them. reimplementing that from the file would get it
// subtly wrong, so ask git for the paths it is willing to see instead
export const gitVisible = (cwd: string) => {
  try {
    const output = execFileSync(
      'git',
      // -z because git quotes any path with unusual characters otherwise, and
      // --others so that a file which is new but not ignored still counts
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd,
        timeout: gitTimeout,
        maxBuffer,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    ).toString();

    return new Set(output.split('\0').filter(Boolean));
  } catch {
    // not a repository, or no git on PATH - either way there is nothing to
    // filter with, and the caller falls back to the list above
    return;
  }
};

// a directory is worth showing when anything visible lives under it, so the
// ancestors of every visible file are what a directory listing can offer
export const visibleDirectories = (files: Set<string>) => {
  const directories = new Set<string>();

  for (const file of files) {
    const parts = file.split('/');

    parts.pop();

    let prefix = '';

    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      directories.add(prefix);
    }
  }

  return directories;
};

// every file in the project, as the find and list tools would see it: what git
// is willing to show, less the directories that are never interesting - git
// only hides node_modules when a .gitignore says so. outside a repository the
// guard above is the only filter there is
export const projectFiles = (cwd: string) => {
  const visible = gitVisible(cwd);

  if (visible) {
    return new Set(
      [...visible].filter(
        (file) => !file.split('/').some((part) => excludedNames.has(part))
      )
    );
  }

  const files = new Set<string>();

  for (const match of globSync('**/*', { cwd, exclude: alwaysExclude })) {
    // glob yields directories too, and a file can vanish mid-listing
    try {
      if (statSync(join(cwd, match)).isFile()) {
        files.add(toPosix(match));
      }
    } catch {
      continue;
    }
  }

  return files;
};
