import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';

// read when the config module first evaluates, so it has to be set before the
// dynamic import below
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-init-'));

process.env.AQ_HOME = resolve(root, 'home');

// git reports the repository root by its real path, which a temp directory
// is not always given as
const base = realpathSync.native(root);
const nested = resolve(base, 'repo', 'src', 'deep');
const repoRoot = resolve(base, 'repo');
const plain = resolve(base, 'plain');
const original = process.cwd();

const { initPrompt } = await import('./init');
const { explore } = await import('./config');

const exploreEnabled = explore.enabled;

before(() => {
  mkdirSync(nested, { recursive: true });
  mkdirSync(resolve(plain, 'sub'), { recursive: true });
  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  process.chdir(nested);
});

afterEach(() => {
  for (const name of ['AGENTIQ.md', 'AGENTS.md', 'CLAUDE.md']) {
    rmSync(resolve(repoRoot, name), { force: true });
    rmSync(resolve(nested, name), { force: true });
  }

  explore.enabled = exploreEnabled;
  process.chdir(nested);
});

after(() => {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
});

describe('initPrompt', () => {
  test('surveys with explore when it is offered', () => {
    explore.enabled = true;

    assert.match(initPrompt(), /`explore` tool/);
  });

  test('surveys with find and read when explore is off', () => {
    explore.enabled = false;

    const prompt = initPrompt();

    assert.doesNotMatch(prompt, /explore/);
    assert.match(prompt, /`find` and `read`/);
  });

  test('writes to the repository root from a subdirectory', () => {
    const prompt = initPrompt();

    assert.ok(
      prompt.includes(`create \`${resolve(repoRoot, 'AGENTIQ.md')}\``),
      prompt
    );
  });

  test('writes to the working directory outside a repository', () => {
    process.chdir(resolve(plain, 'sub'));

    assert.ok(
      initPrompt().includes(`\`${resolve(plain, 'sub', 'AGENTIQ.md')}\``)
    );
  });

  test('improves an existing AGENTIQ.md where it is', () => {
    const existing = resolve(repoRoot, 'AGENTIQ.md');

    writeFileSync(existing, '# notes');

    const prompt = initPrompt();

    assert.ok(prompt.includes(`\`${existing}\` already exists`));
    assert.match(prompt, /`patch`/);
  });

  test('carries over what another agent was told', () => {
    const claude = resolve(repoRoot, 'CLAUDE.md');

    writeFileSync(claude, '# notes');

    const prompt = initPrompt();

    assert.ok(prompt.includes(`\`${claude}\``));
    assert.ok(prompt.includes(`create \`${resolve(repoRoot, 'AGENTIQ.md')}\``));
  });

  test('prefers AGENTS.md to CLAUDE.md, as the system prompt does', () => {
    writeFileSync(resolve(repoRoot, 'AGENTS.md'), '# notes');
    writeFileSync(resolve(repoRoot, 'CLAUDE.md'), '# notes');

    const prompt = initPrompt();

    assert.ok(prompt.includes(resolve(repoRoot, 'AGENTS.md')));
    assert.ok(!prompt.includes(resolve(repoRoot, 'CLAUDE.md')));
  });

  test('covers layout, commands and conventions', () => {
    const prompt = initPrompt();

    assert.match(prompt, /Layout:/);
    assert.match(prompt, /build, test and lint/);
    assert.match(prompt, /Conventions:/);
  });

  test('adds what was typed after the command', () => {
    assert.match(
      initPrompt('  focus on the providers '),
      /Additional guidance from the user:\nfocus on the providers$/
    );
  });

  test('adds nothing for blank guidance', () => {
    assert.doesNotMatch(initPrompt('   '), /Additional guidance/);
    assert.doesNotMatch(initPrompt(), /Additional guidance/);
  });
});
