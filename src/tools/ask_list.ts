import { select } from '@inquirer/prompts';

import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'ask_list',
  'Use this when you need the user to make a decision from a list of choices',
  [
    makeParameter('array', 'choices', 'The list of choices', true, 'string'),
    makeParameter(
      'string',
      'question',
      'The question to display along with the choices',
      true
    )
  ]
);

type Args = {
  question: string;
  choices: string[];
};

export const handler = async ({ question, choices }: Args) =>
  `The user selected "${await select({
    choices,
    message: question
  })}"`;
