import type { Message, ToolCall } from 'ollama';

// what a replaced tool result starts with, so a second pass can tell one it
// already wrote from one it has yet to touch
export const elidedPrefix = '[elided';

// enough of an argument to recognise the call, not so much that the marker
// costs what it just reclaimed
const identifierLength = 60;

export const isElided = (message: Message) =>
  Boolean(message.content?.startsWith(elidedPrefix));

// tool results arrive in the order their calls were made, immediately after
// the assistant message that made them, so the two can be paired by position
// alone - nothing in the transcript carries an id to match on
export const pairCalls = (messages: Message[]) => {
  const pairs = new Map<number, ToolCall>();
  let pending: ToolCall[] = [];
  let next = 0;

  messages.forEach((message, index) => {
    if (message.role === 'tool') {
      const call = pending[next++];

      if (call) {
        pairs.set(index, call);
      }

      return;
    }

    pending = message.tool_calls ?? [];
    next = 0;
  });

  return pairs;
};

// the first argument is the one that says which call this was - a path for
// read, a pattern for find, a command for shell. it is a heuristic, but a
// wrong guess only makes the marker less useful, never incorrect
const identify = (call?: ToolCall) => {
  const args = call?.function?.arguments;
  const first = args ? Object.values(args)[0] : undefined;

  if (typeof first !== 'string' || !first) {
    return '';
  }

  return first.length > identifierLength
    ? `(${first.slice(0, identifierLength)}...)`
    : `(${first})`;
};

// says plainly that something was dropped and what produced it, so the model
// can fetch it again rather than assuming it never existed
export const describeElision = (
  content: string,
  toolName?: string,
  call?: ToolCall
) =>
  `${elidedPrefix}: ${content.length} characters of output from ${
    toolName ?? 'a tool'
  }${identify(call)} - call it again if you still need what it said]`;

// an index is only a safe place to cut where nothing straddles it: every call
// made before it already has its result before it. cutting anywhere else
// orphans a tool result from the call that produced it, and the next request
// is then an incomplete conversation
export const safeBoundaries = (messages: Message[]) => {
  const boundaries: number[] = [];
  let outstanding = 0;

  messages.forEach((message, index) => {
    if (outstanding === 0 && index > 0) {
      boundaries.push(index);
    }

    if (message.role === 'tool') {
      outstanding = Math.max(outstanding - 1, 0);

      return;
    }

    outstanding += message.tool_calls?.length ?? 0;
  });

  return boundaries;
};

// the last user message keeps the turn in progress whole, which is the most
// useful place to cut when there is one. a single long turn has no user
// message to fall back on - that is the case that used to free nothing at all
// - so it cuts as late as the pairing allows instead
export const findSplit = (messages: Message[]) => {
  const boundaries = safeBoundaries(messages);
  const lastUser = messages.findLastIndex((message) => message.role === 'user');

  if (lastUser >= 1 && boundaries.includes(lastUser)) {
    return lastUser;
  }

  return boundaries.length ? boundaries[boundaries.length - 1] : -1;
};
