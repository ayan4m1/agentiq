import { basename, resolve } from 'node:path';

import { explore } from './config';
import { findGitRoot, findProjectOverlay, overlayName } from './prompt';

// built here rather than shipped as a saved command, since what the model
// should do depends on this run - whether explore is offered, where the
// repository root is, and what instructions the project already has
export const initPrompt = (guidance?: string) => {
  const cwd = process.cwd();
  const existing = findProjectOverlay(cwd);
  // an AGENTIQ.md already being followed is improved where it is, wherever up
  // the tree that is. otherwise the new one goes at the repository root, where
  // the search for it ends and so where every directory below will find it
  const target =
    existing && basename(existing) === overlayName
      ? existing
      : resolve(findGitRoot(cwd) ?? cwd, overlayName);

  const survey = explore.enabled
    ? 'Survey the repository with the `explore` tool - ask about its layout and entry points, its manifests and scripts, how it is tested, and how it is linted and formatted. Use `read` only to confirm details the reports leave unclear.'
    : 'Survey the repository with `find` and `read` - its layout and entry points, its manifests and scripts, how it is tested, and how it is linted and formatted.';

  // a file that is already there was written by someone, and what it says
  // that is still true should survive being drafted again
  const start = !existing
    ? `Then create \`${target}\` with \`write\`.`
    : basename(existing) === overlayName
      ? `\`${existing}\` already exists. Read it first, then improve it with \`patch\`, keeping whatever is still accurate rather than rewriting it.`
      : `The project already has instructions for another agent in \`${existing}\`. Read it, carry over whatever applies, and create \`${target}\` with \`write\`.`;

  const prompt = `Draft an ${overlayName} for this project. ${survey}

${start}

${overlayName} is appended to your own system prompt in every future session here, so it should hold only what is specific to this codebase - no general advice about how to be a coding agent. Keep it short and cover:

- Layout: the directories and files that matter, and what each is for. Do not list every file.
- Working here: the commands that build, test and lint the project, and how to run a single test. Take them from the manifests and scripts you found - never guess one.
- Conventions: code style, recurring idioms, and how tests are written and where they live.`;

  const extra = guidance?.trim();

  return extra
    ? `${prompt}\n\nAdditional guidance from the user:\n${extra}`
    : prompt;
};
