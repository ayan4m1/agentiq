import { explore } from '../modules/explore';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'explore',
  'Answers an open-ended question about the codebase by investigating it in a separate conversation that can only read, and returns just a short report of the relevant paths, line ranges and snippets. Use it to orient yourself, so the files read along the way do not fill your own context. Use find and read directly when you already know which file you need.',
  [
    makeParameter(
      'string',
      'question',
      'What to find out, e.g. "Where is the approval mode enforced for shell commands, and what calls it?"'
    )
  ]
);

type Args = {
  question: string;
};

export const handler = async ({ question }: Args) => explore(question);
