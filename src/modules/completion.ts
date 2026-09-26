import { projectFiles, visibleDirectories } from './ignore';

// the project's files and the directories holding them, listed on first use
// and kept until invalidated - so a prompt where Tab is never pressed never
// pays for asking git, and one where it is pressed often only asks once
export const createPathIndex = (cwd = process.cwd()) => {
  let files: Set<string> | undefined;
  let directories: Set<string> | undefined;

  const build = () => {
    files = projectFiles(cwd);
    directories = visibleDirectories(files);
  };

  return {
    get files() {
      if (!files) {
        build();
      }

      return files as Set<string>;
    },
    get directories() {
      if (!directories) {
        build();
      }

      return directories as Set<string>;
    },
    // the model can create and delete files between prompts
    invalidate() {
      files = undefined;
      directories = undefined;
    }
  };
};

export type PathIndex = Pick<
  ReturnType<typeof createPathIndex>,
  'files' | 'directories'
>;

type Sources = {
  commands: readonly string[];
  paths: PathIndex;
};

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

// the prompt library wants whole lines back, keeps those that start with what
// was typed, and completes to whatever they have in common. paths are offered
// one level at a time, as a shell does - a whole tree at once would be a list
// too long to read and a common prefix that never gets anywhere
export const complete = (line: string, { commands, paths }: Sources) => {
  if (line.startsWith('/') && !line.includes(' ')) {
    return commands.map((command) => `/${command}`);
  }

  const start = line.lastIndexOf(' ') + 1;
  const token = line.slice(start);

  if (!token.startsWith('@')) {
    return [];
  }

  const before = line.slice(0, start);
  const parent = parentOf(token.slice(1));
  const children: string[] = [];

  for (const directory of paths.directories) {
    if (parentOf(directory) === parent) {
      children.push(`${directory}/`);
    }
  }

  for (const file of paths.files) {
    if (parentOf(file) === parent) {
      children.push(file);
    }
  }

  return children.sort().map((child) => `${before}@${child}`);
};

// every candidate repeats the sentence typed before it, so the list printed
// under the prompt shows only the word being completed
export const shortCompletions = (_line: string, matches: string[]) =>
  matches.map((match) => match.slice(match.lastIndexOf(' ') + 1));
