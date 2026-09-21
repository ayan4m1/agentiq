// cleared by `agentiq exec` - anything that would put a question on the
// terminal checks it first, since nobody is there to answer
export const terminal = { interactive: true };

// what a question to the user gets back instead of an answer
export const unanswered =
  'Nobody is available to answer - agentiq is running non-interactively. Choose the most reasonable answer yourself and say what you assumed.';

// set by a tool that has already dealt with the user directly, so the run loop
// hands control back instead of taking another turn on the tool's result
export const turn = { yieldToUser: false };

export const yieldToUser = () => (turn.yieldToUser = true);

// reading it is what clears it - the signal only ever describes the turn that
// just finished
export const takeYield = () => {
  const yielded = turn.yieldToUser;

  turn.yieldToUser = false;

  return yielded;
};
