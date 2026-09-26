import chalk from 'chalk';
import { Option, program } from 'commander';

import { getLogger } from '../modules/logging';
import { startAgent } from '../modules/startup';
import { approval } from '../modules/approval';
import { terminal } from '../modules/turn';
import { compactThreshold } from '../modules/ollama';
import { createController } from '../modules/repl';
import { pruneSessions, startSession } from '../modules/session';
import { approval as approvalConfig, ollama } from '../modules/config';
import { ApprovalMode } from '../types';

const log = getLogger('exec');

// commander runs this file as its own executable, the same way it runs
// commands/run.ts, so the prompt and options are parsed here
program
  .argument('<prompt>', 'what to ask the agent')
  .addOption(
    new Option('-m, --mode <mode>', 'how changes are approved')
      .choices(Object.values(ApprovalMode))
      .default(approvalConfig.mode)
  )
  .parse(process.argv);

const [prompt] = program.args;
const { mode } = program.opts<{ mode: ApprovalMode }>();

// both before startup, since a fresh install would otherwise ask which model
// to use. assigned rather than set through setMode, whose banner advertises a
// key that nothing is listening for
terminal.interactive = false;
approval.mode = mode;

const agent = await startAgent();

if (!agent) {
  process.exit(1);
}

const { thinker, schedule, cleanUp } = agent;
const controller = createController({
  thinker,
  compactAt: () => ollama.contextLimit * compactThreshold
});

pruneSessions();

// the same kind of session an interactive run writes, so it can be picked up
// again with `agentiq run --resume`
const id = startSession();
const succeeded = await controller.runPrompt(prompt, schedule);

log.info(chalk.dim(`Session ${id} - resume with agentiq run --resume ${id}`));

cleanUp();
process.exit(succeeded ? 0 : 1);
