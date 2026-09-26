import type { AgentMessage } from '../types';
import { getContentBudget, truncate } from '../utils';

// a recap is a reminder of the thread, not a transcript - one long reply or a
// pasted file must not crowd every other turn out of the window
const messageBudget = 2000;

export const recapPrompt =
  'Recap for the user, in two to four short sentences or bullet points, what was being worked on in the conversation excerpt below, what was done, and what is still outstanding. Address the user directly and write no preamble.';

// a turn starts with something the user typed. tool results have a role of
// their own, and compaction's notes are flagged, so neither starts one - the
// notes are still included when they fall inside the window, since they are
// the only record of what came before it
const startsTurn = ({ role, summary }: AgentMessage) =>
  role === 'user' && !summary;

export const recentTurns = (messages: AgentMessage[], count: number) => {
  if (!(count > 0)) {
    return [];
  }

  const starts = messages.flatMap((message, index) =>
    startsTurn(message) ? [index] : []
  );

  return starts.length > count
    ? messages.slice(starts[starts.length - count])
    : messages;
};

const labelFor = ({ role, summary }: AgentMessage) => {
  if (summary) {
    return 'Earlier notes';
  }

  return role === 'user' ? 'User' : 'Assistant';
};

// only what the two sides said to each other. tool output and reasoning are
// what fill a context window, and a recap does not need either to say what the
// conversation was about
export const renderTranscript = (messages: AgentMessage[]) =>
  truncate(
    messages
      .filter(
        ({ role, content }) =>
          (role === 'user' || role === 'assistant') && content?.trim()
      )
      .map(
        (message) =>
          `${labelFor(message)}: ${truncate(message.content.trim(), messageBudget)}`
      )
      .join('\n\n'),
    getContentBudget()
  );
