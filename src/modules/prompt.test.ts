import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// read when the module first evaluates, so it has to be set before the dynamic
// import below - and it keeps the real global overlay out of these results
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-prompt-'));
const stateDir = resolve(root, 'state');

const project = resolve(root, 'project');
const nested = resolve(project, 'src', 'deep');

process.env.AQ_HOME = stateDir;
// empty rather than deleted, so a value in a local .env cannot fill it back in
process.env.AQ_ENABLE_ROADMAP = '';

// the roadmap path is resolved from the working directory when that module
// loads, so import from inside the scratch project rather than this repo
const original = process.cwd();

mkdirSync(nested, { recursive: true });
process.chdir(project);

const { buildSystemPrompt } = await import('./prompt');
const { ollama, roadmap } = await import('./config');
const { loadSkills, skillsDir } = await import('./skills');

process.chdir(original);
const globalOverlay = resolve(stateDir, 'AGENTIQ.md');
const projectOverlay = resolve(project, 'AGENTIQ.md');
const roadmapFile = resolve(project, 'ROADMAP.md');

before(() => {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(nested, { recursive: true });
  process.chdir(project);
});

afterEach(() => {
  rmSync(globalOverlay, { force: true });
  rmSync(projectOverlay, { force: true });
  rmSync(roadmapFile, { force: true });
  rmSync(skillsDir, { recursive: true, force: true });
  loadSkills();
  roadmap.enabled = false;
  process.chdir(project);
});

after(() => {
  process.chdir(original);
});

describe('the built-in prompt', () => {
  test('is there even with no overlay of any kind', () => {
    // the whole point: an agent handed twelve tools and no instructions is not
    // a useful default
    assert.ok(buildSystemPrompt().length > 0);
  });

  test('tells the model to read before it edits', () => {
    assert.match(buildSystemPrompt(), /Never edit a file you have not read/);
  });

  test('explains which tool is for a process that does not exit', () => {
    assert.match(buildSystemPrompt(), /run_background/);
  });

  test('describes every approval mode, including plan', () => {
    const prompt = buildSystemPrompt();

    assert.match(prompt, /manual/);
    assert.match(prompt, /auto/);
    assert.match(prompt, /present_plan/);
  });
});

describe('the environment block', () => {
  test('names the working directory', () => {
    assert.match(buildSystemPrompt(), new RegExp('Working directory'));
    assert.ok(buildSystemPrompt().includes(process.cwd()));
  });

  test('names the platform, so the model does not guess at the shell', () => {
    assert.ok(buildSystemPrompt().includes(process.platform));
  });

  test('names the shell that will actually interpret commands', () => {
    assert.match(buildSystemPrompt(), /Shell:/);
  });

  test('names the model in use', () => {
    assert.ok(buildSystemPrompt().includes(ollama.model));
  });

  test("gives today's date", () => {
    assert.ok(
      buildSystemPrompt().includes(new Date().toISOString().slice(0, 10))
    );
  });
});

describe('overlays', () => {
  test('appends a project AGENTIQ.md', () => {
    writeFileSync(projectOverlay, 'PROJECT_OVERLAY_MARKER');

    assert.match(buildSystemPrompt(), /PROJECT_OVERLAY_MARKER/);
  });

  test('appends a global one from the state directory', () => {
    writeFileSync(globalOverlay, 'GLOBAL_OVERLAY_MARKER');

    assert.match(buildSystemPrompt(), /GLOBAL_OVERLAY_MARKER/);
  });

  test('puts the project overlay last, so the closest file wins', () => {
    writeFileSync(globalOverlay, 'GLOBAL_OVERLAY_MARKER');
    writeFileSync(projectOverlay, 'PROJECT_OVERLAY_MARKER');

    const prompt = buildSystemPrompt();

    assert.ok(
      prompt.indexOf('GLOBAL_OVERLAY_MARKER') <
        prompt.indexOf('PROJECT_OVERLAY_MARKER')
    );
  });

  test('puts both overlays after the built-in guidance', () => {
    writeFileSync(projectOverlay, 'PROJECT_OVERLAY_MARKER');

    const prompt = buildSystemPrompt();

    assert.ok(
      prompt.indexOf('Never edit a file you have not read') <
        prompt.indexOf('PROJECT_OVERLAY_MARKER')
    );
  });

  test('finds a project overlay from a subdirectory', () => {
    writeFileSync(projectOverlay, 'PROJECT_OVERLAY_MARKER');
    process.chdir(nested);

    // running the agent in src/ should still pick up the file beside
    // package.json, rather than silently going without
    assert.match(buildSystemPrompt(), /PROJECT_OVERLAY_MARKER/);
  });

  test('ignores an empty overlay rather than appending a blank section', () => {
    writeFileSync(projectOverlay, '   \n  \n');

    assert.doesNotMatch(buildSystemPrompt(), /\n\n\n/);
  });
});

describe('skills', () => {
  const addSkill = () => {
    mkdirSync(resolve(skillsDir, 'pdf-tools'), { recursive: true });
    writeFileSync(
      resolve(skillsDir, 'pdf-tools', 'SKILL.md'),
      '---\nname: pdf-tools\ndescription: SKILL_DESCRIPTION_MARKER\n---\n'
    );
    loadSkills();
  };

  test('are left out when there are none', () => {
    assert.doesNotMatch(buildSystemPrompt(), /## Skills/);
  });

  test('are listed with their descriptions', () => {
    addSkill();

    const prompt = buildSystemPrompt();

    assert.match(prompt, /<name>pdf-tools<\/name>/);
    assert.match(prompt, /SKILL_DESCRIPTION_MARKER/);
  });

  test("come before the user's own instructions", () => {
    addSkill();
    writeFileSync(projectOverlay, 'PROJECT_OVERLAY_MARKER');

    const prompt = buildSystemPrompt();

    assert.ok(
      prompt.indexOf('SKILL_DESCRIPTION_MARKER') <
        prompt.indexOf('PROJECT_OVERLAY_MARKER')
    );
  });
});

describe('the roadmap', () => {
  test('is left out unless AQ_ENABLE_ROADMAP is set', () => {
    writeFileSync(
      roadmapFile,
      '# Roadmap\n\n## Todo\n\n- [ ] ROADMAP_MARKER\n'
    );

    const prompt = buildSystemPrompt();

    assert.doesNotMatch(prompt, /Project roadmap/);
    assert.doesNotMatch(prompt, /ROADMAP_MARKER/);
  });

  // buildSystemPrompt reads the flag on every call, so flipping it here is
  // enough - no second import of the module is needed
  test('is appended when AQ_ENABLE_ROADMAP is set', () => {
    roadmap.enabled = true;
    writeFileSync(
      roadmapFile,
      '# Roadmap\n\n## Todo\n\n- [ ] ROADMAP_MARKER\n'
    );

    const prompt = buildSystemPrompt();

    assert.match(prompt, /## Project roadmap/);
    assert.match(prompt, /ROADMAP_MARKER/);
  });
});
