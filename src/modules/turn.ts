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
