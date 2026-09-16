import chalk from 'chalk';
import inquirer from 'inquirer';

import { setMode } from '../modules/approval';
import { ApprovalMode } from '../types';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'present_plan',
  'Show the user a plan and ask permission to start work. Use this before making any changes to a codebase you have just finished investigating, and always while plan mode is active - it is the only way out of plan mode, since the shell, write, and patch tools refuse to run there. The user replies with how they want the work approved.',
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

enum Answer {
  Auto = 'auto',
  Manual = 'manual',
  Keep = 'keep'
}

const renderPlan = ({ title, steps }: Args) => {
  console.log(`\n${chalk.cyan.bold(title)}\n`);

  for (const [index, step] of steps.entries()) {
    console.log(`${chalk.dim(`${index + 1}.`.padStart(4))} ${step}`);
  }

  console.log('');
};

export const handler = async ({ title, steps }: Args) => {
  // a model that ignored the schema and sent a bare string still gets a
  // readable plan rather than a crash on .entries()
  const plan = {
    title,
    steps: Array.isArray(steps) ? steps : [String(steps)]
  };

  renderPlan(plan);

  // deliberately not requestApproval - that answers itself in auto mode, which
  // would let the model grant itself the very permission it is asking for
  const { answer } = await inquirer.prompt({
    type: 'select',
    name: 'answer',
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
      return 'The user is not ready to start. Revise the plan and present it again - do not make any changes yet.';
  }
};
