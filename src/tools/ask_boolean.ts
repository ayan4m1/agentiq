import { confirm } from '@inquirer/prompts';

import { terminal, unanswered } from '../modules/interactive';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'ask_boolean',
  'Use this when you have to ask the user a yes/no question',
  [makeParameter('string', 'question', 'The question to display', true)]
);

type Args = {
  question: string;
};

export const handler = async ({ question }: Args) => {
  if (!terminal.interactive) {
    return unanswered;
  }

  const result = await confirm({
    message: question
  });

  return `The user answered "${result ? 'yes' : 'no'}".`;
};
