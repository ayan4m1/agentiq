import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { home } from './config';
import { toPosix } from './ignore';
import { getLogger } from './logging';
import { describeError, slugFor } from '../utils';

const log = getLogger('rules');
// beside the sessions, and keyed the same way: an answer given about one
// project says nothing about another
const rulesDir = resolve(home, 'approvals');

export type RuleKind = 'command' | 'path';

type Rules = Record<RuleKind, string[]>;

const empty = (): Rules => ({ command: [], path: [] });

const pathFor = () => resolve(rulesDir, `${slugFor(process.cwd())}.json`);

const escapeRegExp = (value: string) =>
  value.replace(/[.+?^${}()|[\]\\]/g, (match) => `\\${match}`);

// only ever written back verbatim, but the file is plain json and a pattern
// typed there by hand should do what it looks like it does. ** spans
// separators and * does not, the same distinction glob makes
export const matchesRule = (pattern: string, value: string) => {
  if (pattern === value) {
    return true;
  }

  if (!pattern.includes('*')) {
    return false;
  }

  const source = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');

  try {
    return new RegExp(`^${source}$`).test(value);
  } catch {
    // a pattern that will not compile is one the user has to fix, and it must
    // not take the session down on the way
    log.warn(
      `Ignoring an approval rule that is not a valid pattern: ${pattern}`
    );

    return false;
  }
};

// a path is stored relative to the project when it is inside it, so the rules
// still mean something on another machine or after the directory moves
export const normalizePath = (value: string) => {
  const absolute = toPosix(resolve(value));
  const root = `${toPosix(process.cwd())}/`;

  return absolute.startsWith(root) ? absolute.slice(root.length) : absolute;
};

const normalize = (kind: RuleKind, value: string) =>
  kind === 'path' ? normalizePath(value) : value.trim();

export const load = (): Rules => {
  const path = pathFor();

  if (!existsSync(path)) {
    return empty();
  }

  try {
    const parsed = JSON.parse(readFileSync(path).toString());

    return {
      command: Array.isArray(parsed?.command) ? parsed.command : [],
      path: Array.isArray(parsed?.path) ? parsed.path : []
    };
  } catch (error) {
    // a hand-edited file with a typo in it should cost the rules, not the run
    log.warn(`Could not read ${path}: ${describeError(error)}`);

    return empty();
  }
};

export const isRemembered = (kind: RuleKind, value: string) => {
  const wanted = normalize(kind, value);

  return load()[kind].some((pattern) => matchesRule(pattern, wanted));
};

// written exactly as it was approved rather than widened into a pattern: a
// rule that turns out to cover more than the user meant is the one thing this
// must not do quietly
export const remember = (kind: RuleKind, value: string) => {
  const wanted = normalize(kind, value);
  const rules = load();

  if (rules[kind].includes(wanted)) {
    return;
  }

  rules[kind].push(wanted);

  const path = pathFor();

  try {
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(rules, null, 2)}\n`);
    log.info(`Will not ask about this ${kind} again: ${wanted}`);
  } catch (error) {
    log.warn(`Could not write ${path}: ${describeError(error)}`);
  }
};
