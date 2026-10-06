import { chatProvider } from '../providers';
import { getLogger } from '../modules/logging';
import { decide as decideConfig } from '../modules/config';
import { makeParameter, makeTool } from '../utils';

const log = getLogger('decide');

export const definition = makeTool(
  'decide',
  'Asks a fast decision model how likely each of one or more yes/no questions is to be true, given some context. Use it for quick judgement calls you would otherwise have to reason through at length. The decision model sees only the context you pass, so include everything the questions depend on.',
  [
    makeParameter(
      'string',
      'context',
      'Everything the questions depend on, e.g. the output of a failing command or the text of a file'
    ),
    makeParameter(
      'array',
      'questions',
      'One or more yes/no questions about the context, e.g. "Is this failure caused by a missing dependency?"',
      true,
      'string'
    )
  ]
);

type Args = {
  context: string;
  questions: string[];
};

const describe = (question: string, probability?: number) =>
  probability === undefined
    ? `You asked "${question}", but no answer came back for it.`
    : `You asked "${question}", the answer is probably ${probability >= 0.5 ? 'yes' : 'no'} (${Math.round(probability * 100)}% yes).`;

export const handler = async ({ context, questions }: Args) => {
  // the tool is only registered when both are there, so this is a guard
  // against that changing rather than something the model should see
  if (!chatProvider.decide || !decideConfig.model) {
    throw new Error(
      'The decide tool needs the ollama provider and a decide.model to be configured'
    );
  }

  if (!questions.length) {
    return 'Ask at least one yes/no question.';
  }

  log.info(`Consulting decision model ${decideConfig.model}...`);

  const { probabilities } = await chatProvider.decide({
    model: decideConfig.model,
    state: context,
    questions
  });

  return questions
    .map((question, index) => describe(question, probabilities[index]))
    .join('\n');
};
