import type { ChatResponse, Message, Tool } from 'ollama';

// an object rather than an enum: enums are the one piece of TypeScript that
// cannot be erased, and node runs these files by stripping types alone. the
// derived union means LogLevel is still both a value and a type
export const LogLevel = {
  Debug: 'debug',
  Info: 'info',
  Warning: 'warn',
  Error: 'error'
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export type LoggingConfig = {
  level: LogLevel;
};

// manual asks before every mutating action, auto asks for none, and plan
// refuses them outright so the model has to propose an approach first
export const ApprovalMode = {
  Manual: 'manual',
  Auto: 'auto',
  Plan: 'plan'
} as const;

export type ApprovalMode = (typeof ApprovalMode)[keyof typeof ApprovalMode];

export type ApprovalConfig = {
  mode: ApprovalMode;
};

// what the user can say to a request. remembering an answer is what makes
// manual mode survivable on a long task, and stopping is what they reach for
// when they would rather take over than argue with the model
export const ApprovalAnswer = {
  Once: 'once',
  Always: 'always',
  No: 'no',
  Stop: 'stop'
} as const;

export type ApprovalAnswer =
  (typeof ApprovalAnswer)[keyof typeof ApprovalAnswer];

// what is being asked about, in a form a remembered answer can be matched
// against next time. absent for anything not worth remembering
export type ApprovalSubject = {
  kind: 'command' | 'path';
  value: string;
};

// a refusal the user explained is worth far more to the model than a bare no -
// without one it tends to retry the identical call
export type ApprovalResult = {
  approved: boolean;
  reason?: string;
  // the user wants the keyboard back rather than another attempt
  stopped?: boolean;
};

export type ShellConfig = {
  path?: string;
  timeout: number;
};

// how hard a reasoning model should think. ollama also accepts a plain
// boolean, which is what an unlevelled model understands
export const ThinkLevel = {
  High: 'high',
  Medium: 'medium',
  Low: 'low'
} as const;

export type ThinkLevel = (typeof ThinkLevel)[keyof typeof ThinkLevel];

export type ThinkSetting = boolean | ThinkLevel;

export type OllamaConfig = {
  host?: string;
  bearerToken?: string;
  model: string;
  contextLimit: number;
  // how long ollama keeps the model in memory after a call - "-1" never
  // unloads it, "0" unloads it immediately
  keepAlive: string;
  // milliseconds enforced between turns. zero for a local server, which has no
  // rate limit to respect - it is here for a metered remote endpoint
  minTurnDelay: number;
  // left undefined when unset, so the field is not sent at all and the choice
  // falls to whatever the model does by default
  think?: ThinkSetting;
  // whether the text a model writes on its way to a tool call is sent back on
  // the turns that follow. off by default: some renderers, ollama's gemma one
  // among them, read a tool call that arrives with text beside it as a turn
  // already answered, and reply to the result with a single end token
  replayPreamble: boolean;
};

export type SessionConfig = {
  // how many saved sessions survive the prune at startup - 0 keeps them all
  limit: number;
  // how many of a resumed session's prompts the up arrow reaches back through -
  // 0 seeds them all
  historyLimit: number;
};

export type TokenizerConfig = {
  repo?: string;
  hfToken?: string;
};

// handlers declare their own argument type, so the parameter here is `never` -
// it is the one shape every handler is assignable to regardless of variance
// rules. Tool arguments arrive as untyped JSON from the model, so the call site
// in modules/ollama.ts is where that gets narrowed.
export type ToolCall = {
  definition: Tool;
  handler: (args: never) => unknown;
};

export type ToolParameter = {
  type: string;
  name: string;
  description: string;
  required: boolean;
  // element type for an array param - models produce malformed arrays without it
  items?: string;
};

// args is what survived validation, which is what the handler is called with -
// coercion may have rewritten it. message is set instead when ok is false, and
// is written for the model to read
export type Validation = {
  ok: boolean;
  args?: Record<string, unknown>;
  message?: string;
};

// ollama's Message plus what agentiq needs to remember about one of its own.
// the extra field rides along into the session file, so a resumed conversation
// still knows which of its user messages the agent wrote for itself
export type AgentMessage = Message & {
  // set by compaction, so nothing downstream has to recognise its notes by
  // what they happen to say
  summary?: boolean;
};

export type ThoughtState = {
  messages: Message[];
  lastResponse?: ChatResponse;
  // set when the user interrupted generation - the turn is rolled back rather
  // than kept, so the caller needs to know it should hand control back
  interrupted?: boolean;
};

export type TokenStats = {
  tools: number;
  total: number;
  system: number;
  messages: number;
  // whether total came from ollama's own count of the last prompt rather than
  // from the tokenizer. the parts stay estimates either way, so they will not
  // add up to the total once this is set
  measured: boolean;
};
