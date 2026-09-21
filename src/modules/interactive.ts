// cleared by `agentiq exec` - anything that would put a question on the
// terminal checks it first, since nobody is there to answer
export const terminal = { interactive: true };

// what a question to the user gets back instead of an answer
export const unanswered =
  'Nobody is available to answer - agentiq is running non-interactively. Choose the most reasonable answer yourself and say what you assumed.';
