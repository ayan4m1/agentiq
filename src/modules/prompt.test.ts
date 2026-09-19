import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// read when the module first evaluates, so it has to be set before the dynamic
// import below - and it keeps the real global overlay out of these results
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-prompt-'));
const stateDir = resolve(root, 'state');

process.env.AQ_HOME = stateDir;

const { buildSystemPrompt } = await import('./prompt');
const { ollama } = await import('./config');

const project = resolve(root, 'project');
const nested = resolve(project, 'src', 'deep');
const globalOverlay = resolve(stateDir, 'AGENTIQ.md');
const projectOverlay = resolve(project, 'AGENTIQ.md');
const original = process.cwd();

before(() => {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(nested, { recursive: true });
  process.chdir(project);
});

afterEach(() => {
  rmSync(globalOverlay, { force: true });
  rmSync(projectOverlay, { force: true });
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
