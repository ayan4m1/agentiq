import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// read when the config module first evaluates, so it has to be set before the
// dynamic import below - and it keeps the real skills out of these results
process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-skills-'));

const { describeSkills, loadSkills, skillsDir } = await import('./skills');

const addSkill = (directory: string, content: string) => {
  mkdirSync(resolve(skillsDir, directory), { recursive: true });
  writeFileSync(resolve(skillsDir, directory, 'SKILL.md'), content);
};

const frontmatter = (name: string, description: string, body = '# Steps') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
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
