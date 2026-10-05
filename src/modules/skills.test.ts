import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

// read when the config module first evaluates, so it has to be set before the
// dynamic import below - and it keeps the real skills out of these results
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-skills-'));

process.env.AQ_HOME = resolve(root, 'home');

const project = resolve(root, 'project');

mkdirSync(project, { recursive: true });
process.chdir(project);

const {
  describeSkills,
  isEnabled,
  listSkills,
  loadSkills,
  projectSkillsDir,
  reloadSkills,
  setEnabled,
  skillsDir
} = await import('./skills');
const { home, skills } = await import('./config');
const { getLogger } = await import('./logging');

const configPath = resolve(home, 'config.yml');

const addSkill = (directory: string, content: string, parent = skillsDir) => {
  mkdirSync(resolve(parent, directory), { recursive: true });
  writeFileSync(resolve(parent, directory, 'SKILL.md'), content);
};

const frontmatter = (name: string, description: string, body = '# Steps') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(projectSkillsDir(), { recursive: true, force: true });
  skills.disabled = [];
  loadSkills();
});

describe('loading skills', () => {
  test('finds nothing when there is no skills directory', () => {
    assert.deepEqual(loadSkills(), []);
    assert.equal(describeSkills(), undefined);
  });

  test('reads the name and description from the frontmatter', () => {
    addSkill('pdf-tools', frontmatter('pdf-tools', 'Work with PDF files'));

    const [skill] = loadSkills();

    assert.equal(skill.name, 'pdf-tools');
    assert.equal(skill.description, 'Work with PDF files');
    assert.equal(skill.path, resolve(skillsDir, 'pdf-tools', 'SKILL.md'));
    assert.equal(skill.directory, resolve(skillsDir, 'pdf-tools'));
  });

  test('accepts frontmatter with crlf line endings', () => {
    addSkill(
      'windows',
      frontmatter('windows', 'Written on Windows').replace(/\n/g, '\r\n')
    );

    assert.equal(loadSkills()[0]?.name, 'windows');
  });

  test('skips a skill with no frontmatter', () => {
    addSkill('bare', '# Just a heading\n');

    assert.deepEqual(loadSkills(), []);
  });

  test('skips a skill missing its description', () => {
    addSkill('half', '---\nname: half\n---\n');

    assert.deepEqual(loadSkills(), []);
  });

  test('skips a skill whose frontmatter will not parse', () => {
    addSkill('broken', '---\nname: [unclosed\n---\n');

    assert.deepEqual(loadSkills(), []);
  });

  test('skips a directory with no SKILL.md', () => {
    mkdirSync(resolve(skillsDir, 'empty'), { recursive: true });

    assert.deepEqual(loadSkills(), []);
  });

  test('ignores loose files in the skills directory', () => {
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(resolve(skillsDir, 'README.md'), 'not a skill');

    assert.deepEqual(loadSkills(), []);
  });

  test('still loads a skill whose name differs from its directory', () => {
    addSkill('folder', frontmatter('other-name', 'Misnamed but usable'));

    assert.equal(loadSkills()[0]?.name, 'other-name');
  });

  test('keeps only the first of two skills with the same name', () => {
    addSkill('a', frontmatter('same', 'First'));
    addSkill('b', frontmatter('same', 'Second'));

    const skills = loadSkills();

    assert.equal(skills.length, 1);
    assert.equal(skills[0].description, 'First');
  });

  test('returns skills in a stable order', () => {
    addSkill('zeta', frontmatter('zeta', 'Last'));
    addSkill('alpha', frontmatter('alpha', 'First'));

    assert.deepEqual(
      loadSkills().map(({ name }) => name),
      ['alpha', 'zeta']
    );
  });
});

describe('project skills', () => {
  test('loads a skill from the project directory', () => {
    addSkill(
      'release',
      frontmatter('release', 'Cut a release'),
      projectSkillsDir()
    );

    const [skill] = loadSkills();

    assert.equal(skill.name, 'release');
    assert.equal(
      skill.path,
      resolve(projectSkillsDir(), 'release', 'SKILL.md')
    );
    assert.equal(skill.directory, resolve(projectSkillsDir(), 'release'));
  });

  test("replaces a global skill with the project's of the same name", () => {
    addSkill('review', frontmatter('review', 'Global review'));
    addSkill(
      'review',
      frontmatter('review', 'Project review'),
      projectSkillsDir()
    );

    const skills = loadSkills();

    assert.equal(skills.length, 1);
    assert.equal(skills[0].description, 'Project review');
    assert.equal(
      skills[0].path,
      resolve(projectSkillsDir(), 'review', 'SKILL.md')
    );
  });

  test('merges both directories in a stable order', () => {
    addSkill('zeta', frontmatter('zeta', 'Global'));
    addSkill('beta', frontmatter('beta', 'Project'), projectSkillsDir());
    addSkill('alpha', frontmatter('alpha', 'Global'));

    assert.deepEqual(
      loadSkills().map(({ name }) => name),
      ['alpha', 'beta', 'zeta']
    );
  });

  test('still loads the project skills when the global ones cannot be read', (t) => {
    t.mock.method(getLogger('skills'), 'warn', () => {});
    mkdirSync(resolve(skillsDir, '..'), { recursive: true });
    writeFileSync(skillsDir, 'not a directory');
    addSkill(
      'release',
      frontmatter('release', 'Cut a release'),
      projectSkillsDir()
    );

    assert.deepEqual(
      loadSkills().map(({ name }) => name),
      ['release']
    );
  });
});

describe('reloading skills', () => {
  test('reports no change when the disk has not changed', () => {
    addSkill('pdf-tools', frontmatter('pdf-tools', 'Work with PDF files'));
    loadSkills();

    assert.equal(reloadSkills(), false);
  });

  test('picks up a skill added after startup', () => {
    loadSkills();
    addSkill(
      'late',
      frontmatter('late', 'Added afterwards'),
      projectSkillsDir()
    );

    assert.equal(reloadSkills(), true);
    assert.match(describeSkills() ?? '', /<name>late<\/name>/);
    assert.equal(reloadSkills(), false);
  });

  test('notices an edited description', () => {
    addSkill('pdf-tools', frontmatter('pdf-tools', 'Old description'));
    loadSkills();
    addSkill('pdf-tools', frontmatter('pdf-tools', 'New description'));

    assert.equal(reloadSkills(), true);
    assert.match(describeSkills() ?? '', /New description/);
  });

  test('notices a skill that was removed', () => {
    addSkill('gone', frontmatter('gone', 'Soon deleted'));
    loadSkills();
    rmSync(resolve(skillsDir, 'gone'), { recursive: true, force: true });

    assert.equal(reloadSkills(), true);
    assert.equal(describeSkills(), undefined);
  });

  test('warns about a broken skill only once', (t) => {
    const warn = t.mock.method(getLogger('skills'), 'warn', () => {});

    addSkill('once', '# no frontmatter\n');
    reloadSkills();
    reloadSkills();
    reloadSkills();

    assert.equal(warn.mock.callCount(), 1);
  });
});

describe('the skills block', () => {
  test('lists each skill with where to read it', () => {
    addSkill('pdf-tools', frontmatter('pdf-tools', 'Work with PDF files'));
    loadSkills();

    const block = describeSkills() ?? '';

    assert.match(block, /^## Skills/);
    assert.match(block, /<available_skills>/);
    assert.match(block, /<name>pdf-tools<\/name>/);
    assert.match(block, /<description>Work with PDF files<\/description>/);
    assert.ok(block.includes(resolve(skillsDir, 'pdf-tools', 'SKILL.md')));
  });

  test('leaves the body out, for the model to read when it needs it', () => {
    addSkill('secret', frontmatter('secret', 'Has a body', 'BODY_ONLY_MARKER'));
    loadSkills();

    assert.doesNotMatch(describeSkills() ?? '', /BODY_ONLY_MARKER/);
  });

  test('escapes markup in a description', () => {
    addSkill('markup', frontmatter('markup', '"Use <b> & </skill>"'));
    loadSkills();

    assert.match(describeSkills() ?? '', /Use &lt;b&gt; &amp; &lt;\/skill&gt;/);
  });

  test('describes what was loaded rather than rescanning', () => {
    addSkill('early', frontmatter('early', 'Loaded at startup'));
    loadSkills();
    addSkill('late', frontmatter('late', 'Added afterwards'));

    assert.doesNotMatch(describeSkills() ?? '', /late/);
  });
});

describe('enabling skills', () => {
  test('starts every skill out enabled', () => {
    addSkill('pdf-tools', frontmatter('pdf-tools', 'Work with PDF files'));
    loadSkills();

    assert.equal(isEnabled('pdf-tools'), true);
  });

  test('leaves a disabled skill out of the block', () => {
    addSkill('kept', frontmatter('kept', 'Still listed'));
    addSkill('dropped', frontmatter('dropped', 'Turned off'));
    loadSkills();
    setEnabled('dropped', false);

    const block = describeSkills() ?? '';

    assert.match(block, /<name>kept<\/name>/);
    assert.doesNotMatch(block, /dropped/);
    // still installed, so it can be turned back on
    assert.equal(listSkills().length, 2);
  });

  test('drops the whole block once every skill is disabled', () => {
    addSkill('only', frontmatter('only', 'The one skill'));
    loadSkills();
    setEnabled('only', false);

    assert.equal(describeSkills(), undefined);
  });

  test('saves the disabled skills to config.yml, sorted', () => {
    setEnabled('zeta', false);
    setEnabled('alpha', false);
    setEnabled('zeta', false);

    assert.deepEqual(skills.disabled, ['alpha', 'zeta']);
    assert.match(
      readFileSync(configPath, 'utf8'),
      /disabled:\s*\n\s*- alpha\s*\n\s*- zeta/
    );

    setEnabled('alpha', true);

    assert.deepEqual(skills.disabled, ['zeta']);
    assert.equal(isEnabled('alpha'), true);
  });

  test('keeps the change for this session when it cannot be saved', (t) => {
    const warn = t.mock.method(getLogger('skills'), 'warn', () => {});
    const original = readFileSync(configPath, 'utf8');

    writeFileSync(configPath, 'skills: [unclosed\n');

    try {
      setEnabled('broken', false);
    } finally {
      writeFileSync(configPath, original);
    }

    assert.equal(isEnabled('broken'), false);
    assert.match(
      String(warn.mock.calls[0]?.arguments[0]),
      /Could not save the disabled skills/
    );
  });
});
