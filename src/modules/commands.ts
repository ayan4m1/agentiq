import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import { parse } from 'yaml';

import { home } from './config';
import { getLogger } from './logging';
import { describeError, frontmatterPattern } from '../utils';
import type { CustomCommand } from '../types';

const log = getLogger('commands');

// one markdown file per command, named for it - kept for every project here,
// or for just one in its own .agentiq/commands, which wins on a clash
export const commandsDir = resolve(home, 'commands');

export const projectCommandsDir = () =>
  resolve(process.cwd(), '.agentiq', 'commands');

// a name that has to survive being typed after a / and split on whitespace
const namePattern = /^[A-Za-z0-9][\w.-]*$/;

// $1 to $9, but not the start of $10 - nobody types ten arguments, and a price
// like $100 in a prompt should be left as it was written
const positionalPattern = /\$([1-9])(?!\d)/g;
const argumentsPattern = /\$ARGUMENTS\b/g;

// the directories are rescanned before every prompt, so a file that cannot be
// used is only worth a warning the first time it is seen
const warned = new Set<string>();

const warnOnce = (message: string) => {
  if (!warned.has(message)) {
    warned.add(message);
    log.warn(message);
  }
};

export const parseCommandFile = (path: string): CustomCommand | undefined => {
  const name = basename(path, extname(path));

  if (!namePattern.test(name)) {
    warnOnce(`Skipping command ${path} - /${name} could not be typed`);

    return;
  }

  let text: string;
  let description: string | undefined;

  try {
    text = readFileSync(path, 'utf8');

    // frontmatter is optional - a file that is only a prompt is a command too
    const match = frontmatterPattern.exec(text);

    if (match) {
      const metadata = (parse(match[1]) ?? {}) as Record<string, unknown>;

      if (typeof metadata.description === 'string') {
        description = metadata.description.trim() || undefined;
      }

      text = text.slice(match[0].length);
    }
  } catch (error) {
    warnOnce(`Skipping command ${path} - ${describeError(error)}`);

    return;
  }

  const body = text.trim();

  if (!body) {
    warnOnce(`Skipping command ${path} - it has no prompt`);

    return;
  }

  return { name, description, body, path };
};

const readDirectory = (directory: string) => {
  try {
    return (
      readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extname(entry.name) === '.md')
        .map((entry) => resolve(directory, entry.name))
        // sorted so /help lists them the same way every time
        .sort()
    );
  } catch (error) {
    // no commands directory is the ordinary case, not worth a word
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnOnce(`Could not read ${directory}: ${describeError(error)}`);
    }

    return [];
  }
};

// always rescans - two small directories - so a command written or edited
// mid-session can be used straight away. the built-in commands are passed in
// rather than imported, since the controller that owns them imports this, and
// on a clash the built-in is the one that runs
export const loadCommands = (reserved: readonly string[] = []) => {
  const byName = new Map<string, CustomCommand>();

  // the project's directory is read last, so its commands replace the global
  // ones of the same name
  for (const directory of [commandsDir, projectCommandsDir()]) {
    for (const path of readDirectory(directory)) {
      const command = parseCommandFile(path);

      if (!command) {
        continue;
      }

      if (reserved.includes(command.name)) {
        warnOnce(
          `Skipping command ${path} - /${command.name} is a built-in command`
        );
        continue;
      }

      byName.set(command.name, command);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// the prompt a command sends, given whatever was typed after its name.
// arguments with nowhere to go are added below the prompt rather than lost
export const expandCommand = ({ body }: CustomCommand, args = '') => {
  const raw = args.trim();
  const words = raw ? raw.split(/\s+/) : [];
  let placed = false;

  // replaced through a function, so a $& or $' in what was typed is kept as
  // typed rather than read as a replacement pattern
  const expanded = body
    .replace(argumentsPattern, () => {
      placed = true;

      return raw;
    })
    .replace(positionalPattern, (_, index: string) => {
      placed = true;

      return words[Number(index) - 1] ?? '';
    });

  return !placed && raw ? `${expanded}\n\n${raw}` : expanded;
};
