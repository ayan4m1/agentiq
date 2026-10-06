// cleared by `agentiq exec` - anything that would put a question on the
// terminal checks it first, since nobody is there to answer
export const terminal = { interactive: true };

// what a question to the user gets back instead of an answer
export const unanswered =
  'Nobody is available to answer - agentiq is running non-interactively. Choose the most reasonable answer yourself and say what you assumed.';

// set by a tool that has already dealt with the user directly, so the run loop
// hands control back instead of taking another turn on the tool's result
// searches counts the web searches made since the user last sent a message -
// the search tool refuses once it reaches ceramic.perTurnLimit
export const turn = { yieldToUser: false, searches: 0 };

export const yieldToUser = () => (turn.yieldToUser = true);

// called as each user message is sent - the limits it resets cover everything
// the model does in answer to one message, however many rounds that takes
export const beginUserTurn = () => {
  turn.searches = 0;
};

// reading it is what clears it - the signal only ever describes the turn that
// just finished
export const takeYield = () => {
  const yielded = turn.yieldToUser;

  turn.yieldToUser = false;

  return yielded;
};
