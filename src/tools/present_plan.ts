import chalk from 'chalk';
import { select } from '@inquirer/prompts';

import { setMode } from '../modules/approval';
import { yieldToUser } from '../modules/turn';
import { ApprovalMode } from '../types';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'present_plan',
  'Show the user a plan and ask permission to start work. Use this before making any changes to a codebase you have just finished investigating, and always while plan mode is active. The user replies with how they want the work approved.',
  [
    makeParameter(
      'string',
      'title',
      'A one-line summary of what the plan accomplishes and why it is ready to run'
    ),
    makeParameter(
      'array',
      'steps',
      'The ordered steps of the plan, one concrete action per entry',
      true,
      'string'
    )
  ]
);

type Args = {
  title: string;
  steps: string[];
};

const Answer = {
  Auto: 'auto',
  Manual: 'manual',
  Keep: 'keep'
} as const;

type Answer = (typeof Answer)[keyof typeof Answer];

const renderPlan = ({ title, steps }: Args) => {
  console.log(`\n${chalk.cyan.bold(title)}\n`);

  for (const [index, step] of steps.entries()) {
    console.log(`${chalk.dim(`${index + 1}.`.padStart(4))} ${step}`);
  }

  console.log('');
};

export const handler = async ({ title, steps }: Args) => {
  // arguments are coerced against the schema before they get here, so steps is
  // an array of strings whatever the model actually sent
  renderPlan({ title, steps });

  // deliberately not requestApproval - that answers itself in auto mode, which
  // would let the model grant itself the very permission it is asking for
  const answer = await select({
    message: 'How would you like to proceed?',
    default: Answer.Manual,
    choices: [
      {
        name: 'Go ahead, and approve every change automatically',
        value: Answer.Auto
      },
      { name: 'Go ahead, but ask me before each change', value: Answer.Manual },
      { name: 'Not yet - keep planning', value: Answer.Keep }
    ]
  });

  switch (answer) {
    case Answer.Auto:
      setMode(ApprovalMode.Auto);

      return 'The user approved the plan and turned on auto-approval. Start working through the steps - changes will apply without further prompting.';
    case Answer.Manual:
      setMode(ApprovalMode.Manual);

      return 'The user approved the plan. Start working through the steps, but expect to be asked to confirm every change.';
    default:
      // the run loop stops here rather than taking another turn, so this is
      // read alongside whatever the user types next - it reports what happened
      // and leaves the next move to them
      yieldToUser();

      return 'The user declined the plan and has not approved any work.';
  }
};
