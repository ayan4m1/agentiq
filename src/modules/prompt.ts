import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { getLogger } from './logging';
import { home, ollama, roadmap, shell } from './config';
import { describeRoadmap } from './roadmap';
import { describeSkills } from './skills';

const log = getLogger('prompt');
// the same name in a project directory and in ~/.agentiq, so a user who learns
// one has learned the other
const overlayName = 'AGENTIQ.md';
// git is only consulted to describe the working tree - a repository that takes
// longer than this to answer is not worth holding up the first prompt for
const gitTimeout = 2000;

// what the model is told it is and how it should work. this is compiled in
// rather than read from disk: an agent with no instructions at all is not a
// useful default, and AGENTIQ.md is an overlay on this rather than a
// replacement for it
const defaultPrompt = `You are agentiq, a coding agent working directly in a user's project from the command line.

## How to work

- Investigate before you act. Use \`find\` to locate files and \`read\` to study them. Never edit a file you have not read.
- Prefer the smallest change that solves the problem. Match the surrounding code's style, naming, and structure rather than imposing your own.
- Work in steps, and report what you actually did. If something failed, say so plainly and include the error rather than describing the attempt as a success.
- When a request is ambiguous in a way that changes the work, ask using \`ask_boolean\` or \`ask_list\`. Otherwise decide for yourself and state the assumption.
- Do not commit to version control unless the user asks you to.

## Tools

- \`find\` locates files by glob pattern and can search inside them. Use it to orient yourself before reading.
- \`read\` returns a file with line numbers. It is paginated - when the result says lines remain, call it again with \`offset\`.
- \`patch\` replaces an exact snippet of an existing file. Copy \`oldText\` verbatim from what \`read\` returned, without the line numbers, and include enough surrounding text that it occurs exactly once. If it reports several matches, add more context rather than setting \`replaceAll\` - only set that when you genuinely mean every occurrence.
- \`write\` creates a new file or replaces one entirely. Prefer \`patch\` for a file that already exists: \`write\` discards everything not in the content you supply.
- \`shell\` runs a command and waits for it to finish. Use it for builds, tests, and version control.
- \`run_background\` is for anything that does not exit on its own - dev servers, watch builds, log tails. Never start one of those with \`shell\`, which will block until it times out. Read its output with \`read_job\` and end it with \`stop_job\`.
- \`fetch\` retrieves a URL and returns it as text.
- \`present_plan\` shows the user a plan and asks permission to begin work.

## Approval

Every change you make is subject to the user's current approval mode.

- **manual** - the user confirms each change before it is applied. A refusal comes back with a reason: read it and adapt. Do not retry the identical call.
- **auto** - changes apply without confirmation. Be correspondingly careful.
- **plan** - nothing may be written and no command may be run. Investigate with \`read\`, \`find\`, and \`fetch\`, then call \`present_plan\` to propose an approach. Work starts only once the user approves.`;

// node picks the shell for us when AQ_SHELL is unset (see modules/jobs.ts), so
// the model would otherwise have to guess which one its commands reach
const describeShell = () => {
  if (shell.path) {
    return shell.path;
  }

  return process.platform === 'win32'
    ? (process.env.ComSpec ?? 'cmd.exe')
    : '/bin/sh';
};

const runGit = (args: string[], cwd: string) =>
  execFileSync('git', args, {
    cwd,
    timeout: gitTimeout,
    stdio: ['ignore', 'pipe', 'ignore']
  })
    .toString()
    .trim();

// branch and a count of what is dirty, not the file list - the model can run
// git itself when it needs detail, and this is paid for on every single turn
const describeGit = (cwd: string) => {
  try {
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const changed = runGit(['status', '--porcelain'], cwd)
      .split('\n')
      .filter(Boolean).length;

    return `branch ${branch}, ${changed} uncommitted change(s)`;
  } catch {
    // not a repository, or no git on PATH - either way there is nothing to say
    return;
  }
};

// the repository root if there is one, so the overlay search has somewhere to
// stop other than the filesystem root
const findGitRoot = (cwd: string) => {
  try {
    return runGit(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return;
  }
};

// facts that only hold for this run. a model that does not know its platform
// reaches for `ls` on Windows, and one that does not know the date cannot
// reason about anything it reads
const describeEnvironment = () => {
  const cwd = process.cwd();
  const git = describeGit(cwd);
  const lines = [
    `- Working directory: ${cwd}`,
    `- Platform: ${process.platform}`,
    `- Shell: ${describeShell()} - this is what interprets commands you pass to \`shell\` and \`run_background\``,
    `- Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `- Model: ${ollama.model}`
  ];

  if (git) {
    lines.push(`- Git: ${git}`);
  }

  return `## Environment\n\n${lines.join('\n')}`;
};

// walks from the working directory up to the repository root, so running the
// agent in src/ still finds the AGENTIQ.md that sits beside package.json
const findProjectOverlay = (cwd: string) => {
  const root = findGitRoot(cwd);
  let directory = cwd;

  while (true) {
    const candidate = resolve(directory, overlayName);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);

    // stop at the repository root, or at the filesystem root when there is no
    // repository - dirname() of the root returns the root itself
    if (directory === root || parent === directory) {
      return;
    }

    directory = parent;
  }
};

const readOverlay = (path?: string) => {
  if (!path) {
    return;
  }

  try {
    const content = readFileSync(path).toString().trim();

    if (!content) {
      return;
    }

    log.debug(`Applying overlay from ${path}`);

    return content;
  } catch (error) {
    // the global overlay is optional, so its absence is not worth mentioning
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${path}: ${(error as Error).message}`);
    }

    return;
  }
};

// the built-in prompt, then the facts about this run and the skills on offer,
// then the user's own instructions - global first and project second, so the
// more specific file is the last thing the model reads
export const buildSystemPrompt = () => {
  const cwd = process.cwd();
  const sections = [
    defaultPrompt,
    describeEnvironment(),
    describeSkills(),
    readOverlay(resolve(home, overlayName)),
    readOverlay(findProjectOverlay(cwd)),
    // AGENTIQ.md is how the project instructs the model; the roadmap is what the
    // project has been doing. both are standing context, so they arrive together,
    // and composing here rather than per turn is what lets the token accounting
    // count it once.
    roadmap.enabled ? describeRoadmap() : undefined
  ];

  return sections.filter(Boolean).join('\n\n');
};
