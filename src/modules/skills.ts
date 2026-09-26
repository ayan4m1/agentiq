import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

import { home } from './config';
import { getLogger } from './logging';
import { describeError, getContentBudget, truncate } from '../utils';
import type { Skill } from '../types';

const log = getLogger('skills');

// one directory per skill, each holding a SKILL.md - the layout the agent
// skills spec defines, so a skill written for another agent drops straight in
export const skillsDir = resolve(home, 'skills');

const skillFile = 'SKILL.md';
// the frontmatter has to open the file - a --- further down is a horizontal
// rule in the body, not metadata
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// resent on every turn like the roadmap, so it gets the same small share
const promptBudget = getContentBudget(0.05);

// set by loadSkills() at startup. describeSkills() reads this rather than the
// disk, so /model rebuilding the prompt does not rescan the directory
let loaded: Skill[] | undefined;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const parseSkill = (directory: string): Skill | undefined => {
  const path = resolve(skillsDir, directory, skillFile);

  if (!existsSync(path)) {
    log.warn(`Skipping skill ${directory} - it has no ${skillFile}`);

    return;
  }

  let metadata: unknown;

  try {
    const match = frontmatterPattern.exec(readFileSync(path, 'utf8'));

    if (!match) {
      log.warn(`Skipping skill ${directory} - ${path} has no frontmatter`);

      return;
    }

    metadata = parse(match[1]);
  } catch (error) {
    log.warn(`Skipping skill ${directory} - ${describeError(error)}`);

    return;
  }

  const { name, description } = (metadata ?? {}) as Record<string, unknown>;

  if (!isText(name) || !isText(description)) {
    log.warn(
      `Skipping skill ${directory} - its frontmatter needs both a name and a description`
    );

    return;
  }

  // the spec says these should agree, but refusing a skill over it would
  // punish a cosmetic mistake - the name in the file is the one the model sees
  if (name !== directory) {
    log.warn(
      `Skill ${directory} is named "${name}" in its frontmatter - the two should match`
    );
  }

  return {
    name: name.trim(),
    description: description.trim(),
    path,
    directory: resolve(skillsDir, directory)
  };
};

// always rescans, so calling it again picks up whatever changed on disk
export const loadSkills = () => {
  let entries: string[] = [];

  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // sorted so the prompt is identical from one run to the next
      .sort();
  } catch (error) {
    // no skills directory is the ordinary case, not worth a word
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${skillsDir}: ${describeError(error)}`);
    }
  }

  const skills: Skill[] = [];

  for (const entry of entries) {
    const skill = parseSkill(entry);

    if (!skill) {
      continue;
    }

    if (skills.some(({ name }) => name === skill.name)) {
      log.warn(
        `Skipping skill ${entry} - another skill is already named "${skill.name}"`
      );
      continue;
    }

    skills.push(skill);
  }

  log.debug(`Loaded ${skills.length} skill(s) from ${skillsDir}`);
  loaded = skills;

  return skills;
};

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// only the name, description and location go in the prompt - the model reads
// the SKILL.md itself when a task calls for it, so a long skill costs nothing
// on the turns that do not use it
export const describeSkills = () => {
  const skills = loaded ?? loadSkills();

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
