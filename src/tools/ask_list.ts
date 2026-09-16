import { select } from '@inquirer/prompts';

import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'ask_list',
  'Prompt the user to select from a list of choices',
  [
    makeParameter('array', 'choices', 'The list of choices', true, 'string'),
    makeParameter(
      'string',
      'message',
      'The message to display along with the choices',
      true
    )
  ]
);

type Args = {
  message: string;
  choices: string[];
};

export const handler = async ({ message, choices }: Args) =>
  `The user selected ${await select({
    choices,
    message
  })}`;
