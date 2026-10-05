import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

import { home, saveSetting, skills as config } from './config';
import { getLogger } from './logging';
import {
  describeError,
  frontmatterPattern,
  getContentBudget,
  truncate
} from '../utils';
import type { Skill } from '../types';

const log = getLogger('skills');

// one directory per skill, each holding a SKILL.md - the layout the agent
// skills spec defines, so a skill written for another agent drops straight in.
// kept for every project here, or for just one in its own .agentiq/skills,
// which wins on a clash
export const skillsDir = resolve(home, 'skills');

export const projectSkillsDir = () =>
  resolve(process.cwd(), '.agentiq', 'skills');

const skillFile = 'SKILL.md';
// resent on every turn like the roadmap, so it gets the same small share
const promptBudget = getContentBudget(0.05);

// set by loadSkills() at startup and again before each message the user
// sends. describeSkills() reads this rather than the disk, so building the
// prompt never rescans the directories
let loaded: Skill[] | undefined;

// the directories are rescanned before every message, so a skill that cannot
// be used is only worth a warning the first time it is seen
const warned = new Set<string>();

const warnOnce = (message: string) => {
  if (!warned.has(message)) {
    warned.add(message);
    log.warn(message);
  }
};

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const parseSkill = (
  root: string,
  directory: string
): Skill | undefined => {
  const folder = resolve(root, directory);
  const path = resolve(folder, skillFile);

  if (!existsSync(path)) {
    warnOnce(`Skipping skill ${folder} - it has no ${skillFile}`);

    return;
  }

  let metadata: unknown;

  try {
    const match = frontmatterPattern.exec(readFileSync(path, 'utf8'));

    if (!match) {
      warnOnce(
        `Skipping skill ${folder} - its ${skillFile} has no frontmatter`
      );

      return;
    }

    metadata = parse(match[1]);
  } catch (error) {
    warnOnce(`Skipping skill ${folder} - ${describeError(error)}`);

    return;
  }

  const { name, description } = (metadata ?? {}) as Record<string, unknown>;

  if (!isText(name) || !isText(description)) {
    warnOnce(
      `Skipping skill ${folder} - its frontmatter needs both a name and a description`
    );

    return;
  }

  // the spec says these should agree, but refusing a skill over it would
  // punish a cosmetic mistake - the name in the file is the one the model sees
  if (name !== directory) {
    warnOnce(
      `Skill ${folder} is named "${name}" in its frontmatter - the two should match`
    );
  }

  return {
    name: name.trim(),
    description: description.trim(),
    path,
    directory: folder
  };
};

const readDirectory = (root: string) => {
  try {
    return (
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        // sorted so the prompt is identical from one run to the next
        .sort()
    );
  } catch (error) {
    // no skills directory is the ordinary case, not worth a word
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnOnce(`Could not read ${root}: ${describeError(error)}`);
    }

    return [];
  }
};

// always rescans, so calling it again picks up whatever changed on disk
export const loadSkills = () => {
  const byName = new Map<string, Skill>();

  // the project's directory is read last, so its skills replace the global
  // ones of the same name
  for (const root of [skillsDir, projectSkillsDir()]) {
    const names = new Set<string>();

    for (const entry of readDirectory(root)) {
      const skill = parseSkill(root, entry);

      if (!skill) {
        continue;
      }

      if (names.has(skill.name)) {
        warnOnce(
          `Skipping skill ${skill.directory} - another skill is already named "${skill.name}"`
        );
        continue;
      }

      names.add(skill.name);
      byName.set(skill.name, skill);
    }
  }

  const skills = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  log.debug(
    `Loaded ${skills.length} skill(s) from ${skillsDir} and ${projectSkillsDir()}`
  );
  loaded = skills;

  return skills;
};

// what the prompt is built from - a description edited or a skill moved
// changes it as surely as one added or removed
const fingerprint = (skills: Skill[] | undefined) =>
  JSON.stringify(
    (skills ?? []).map(({ name, description, path }) => [
      name,
      description,
      path
    ])
  );

// rescans, and says whether the prompt has to be built again. the prompt is
// left alone when nothing changed, so it stays exactly what was sent before
export const reloadSkills = () => {
  const before = fingerprint(loaded);

  return fingerprint(loadSkills()) !== before;
};

// every skill installed, enabled or not - /skills offers the disabled ones
// back to be turned on again
export const listSkills = () => loaded ?? loadSkills();

export const isEnabled = (name: string) => !config.disabled.includes(name);

// takes effect the next time the prompt is built, and is saved to config.yml
// so the runs that follow start the same way. a save that fails still leaves
// the change in place for this session, as /context-limit does
export const setEnabled = (name: string, enabled: boolean) => {
  const others = config.disabled.filter((disabled) => disabled !== name);

  config.disabled = enabled ? others : [...others, name].sort();

  try {
    saveSetting('skills', 'disabled', config.disabled);
  } catch (error) {
    log.warn(
      `Could not save the disabled skills to config.yml - ${describeError(error)}`
    );
  }
};

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// only the name, description and location go in the prompt - the model reads
// the SKILL.md itself when a task calls for it, so a long skill costs nothing
// on the turns that do not use it. a disabled skill costs nothing at all
export const describeSkills = () => {
  const skills = listSkills().filter(({ name }) => isEnabled(name));

  if (!skills.length) {
    return;
  }

  const entries = skills.map((skill) =>
    [
      '<skill>',
      `<name>${escape(skill.name)}</name>`,
      `<description>${escape(skill.description)}</description>`,
      `<location>${escape(skill.path)}</location>`,
      '</skill>'
    ].join('\n')
  );

  return truncate(
    [
      '## Skills',
      "Each skill below is a set of instructions for a particular kind of task. When a task matches a skill's description, `read` its SKILL.md before you start and follow it. Paths a skill mentions are relative to the directory its SKILL.md is in.",
      `<available_skills>\n${entries.join('\n')}\n</available_skills>`
    ].join('\n\n'),
    promptBudget
  );
};
