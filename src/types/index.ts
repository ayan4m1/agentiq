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

export const Provider = {
  Anthropic: 'anthropic',
  Ollama: 'ollama'
} as const;

export type Provider = (typeof Provider)[keyof typeof Provider];

// what applies whichever provider serves the model. anything only one of them
// understands lives in that provider's own section
export type ProviderConfig = {
  name: Provider;
  // filled in from ~/.agentiq/models.yml rather than read as a setting - see
  // modules/models.ts
  model: string;
  contextLimit: number;
  // milliseconds enforced between turns. zero for a local server, which has no
  // rate limit to respect - it is here for a metered remote endpoint
  minTurnDelay: number;
  // left undefined when unset, so the field is not sent at all and the choice
  // falls to whatever the model does by default
  think?: ThinkSetting;
};

export type AnthropicConfig = {
  apiKey: string;
  baseUrl: string;
};

export type LoggingConfig = {
  level: LogLevel;
  detailed: boolean;
  logThoughts: boolean;
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
  // how long ollama keeps the model in memory after a call - "-1" never
  // unloads it, "0" unloads it immediately
  keepAlive: string;
  // whether the text a model writes on its way to a tool call is sent back on
  // the turns that follow. off by default: some renderers, ollama's gemma one
  // among them, read a tool call that arrives with text beside it as a turn
  // already answered, and reply to the result with a single end token
  replayPreamble: boolean;
  // whether tool calls a model writes into its reply as text - qwen's XML, a
  // <tool_call> tag, a fenced or bare JSON call - are recovered and dispatched
  // instead of ending the turn. on by default
  recoverToolCalls: boolean;
};

// a model and the huggingface repo whose tokenizer matches it. the two are only
// useful together - a tokenizer from the wrong model counts a prompt the server
// will render differently - so they are chosen and saved as a pair. the
// tokenizer may instead be a local directory holding tokenizer.json and
// tokenizer_config.json, ./-relative to ~/.agentiq or absolute. an anthropic
// model has no published tokenizer and is counted by the API, so it has none
export type ModelEntry = {
  model: string;
  tokenizer?: string;
};

// ~/.agentiq/models.yml: every pair the user has set up, and which of them the
// next run starts on - both kept per provider, since a model only makes sense
// to the server it was set up against. a provider nobody has used yet has no
// key at all
export type ModelStore = {
  active: Partial<Record<Provider, string>>;
  models: Partial<Record<Provider, ModelEntry[]>>;
};

export type SessionConfig = {
  // how many saved sessions survive the prune at startup - 0 keeps them all
  limit: number;
  // how many of a resumed session's prompts the up arrow reaches back through -
  // 0 seeds them all
  historyLimit: number;
  // how many of the most recent turns /recap covers when no count is given -
  // 0 covers them all
  recapTurns: number;
};

export type TokenizerConfig = {
  repo?: string;
  hfToken?: string;
};

export type RoadmapConfig = {
  enabled: boolean;
};

export type SkillsConfig = {
  // the names of installed skills to leave out of the prompt - kept rather than
  // the enabled ones, so a newly installed skill starts out on
  disabled: string[];
};

export type ExploreConfig = {
  enabled: boolean;
  // how many rounds of tool calls an exploration gets before it has to report
  rounds: number;
};

// the shapes the rest of agentiq speaks, whichever provider is behind them.
// they follow ollama's field names, snake_case and all, because messages are
// written to session files as they are - a rename would orphan every saved
// conversation - and because it lets the ollama provider pass them straight
// through. another provider translates to and from these at its own edge
export type ChatMessage = {
  role: string;
  content: string;
  // reasoning, when the model separates it from the answer
  thinking?: string;
  images?: Uint8Array[] | string[];
  tool_calls?: ModelToolCall[];
  // set on a tool result, naming the tool that produced it
  tool_name?: string;
  // set on a tool result, naming the call it answers - a provider that pairs
  // results with calls by id needs it, one that pairs them by order does not
  tool_call_id?: string;
  // the reply exactly as the provider that wrote it sent it. a provider may
  // need its own blocks back verbatim - anthropic's thinking blocks carry
  // signatures that cannot be rebuilt from the text - and ignores what another
  // provider left here. it rides along into the session file like the rest
  native?: NativeContent;
};

export type NativeContent = {
  provider: Provider;
  content: unknown;
};

// a call as the model made it. the arguments are untyped JSON until
// validateArgs() has looked at them
export type ModelToolCall = {
  // the provider's id for the call, when it gives one
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

// a tool as it is offered to the model - a JSON schema of its parameters
export type ToolDefinition = {
  type: string;
  function: {
    name?: string;
    description?: string;
    parameters?: {
      type?: string;
      required?: string[];
      properties?: Record<
        string,
        {
          type?: string | string[];
          items?: unknown;
          description?: string;
          enum?: unknown[];
        }
      >;
    };
  };
};

// what every provider is asked. anything only one provider understands - how
// long ollama keeps a model loaded, the window it renders the prompt into - is
// added by that provider from its own config
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  think?: ThinkSetting;
};

// what a provider counted for the request, when it says. the prompt figure is
// the one the context estimate is corrected against
export type ChatUsage = {
  promptTokens?: number;
  outputTokens?: number;
  outputDurationNs?: number;
};

// one piece of a streamed reply. the last one carries the usage
export type ChatChunk = {
  message: ChatMessage;
  done?: boolean;
  usage?: ChatUsage;
};

// a reply arriving in pieces, which can be cut off part way through
export type ChatStream = AsyncIterable<ChatChunk> & {
  abort: () => void;
};

// a model the provider can serve. ollama names a model twice, and either name
// may be the one the user configured, so both are kept
export type ModelSummary = {
  name: string;
  id: string;
};

// what a provider says about one model. empty capabilities means it did not
// say, not that the model can do nothing
export type ModelDetails = {
  capabilities: string[];
  contextLength?: number;
};

// everything agentiq needs from whatever serves the model. ollama is the only
// one today (see providers/ollama.ts); another is a new implementation of this
// rather than a change to the code that calls it
export interface ChatProvider {
  // who is being talked to, for messages about failing to reach them
  readonly label: string;
  // a turn of the main conversation, shown to the user as it arrives
  stream(request: ChatRequest): Promise<ChatStream>;
  // a reply wanted whole - a side question, or a round of an exploration
  complete(request: ChatRequest): Promise<ChatMessage>;
  // cancels whatever is in flight
  abort(): void;
  listModels(): Promise<ModelSummary[]>;
  describeModel(model: string): Promise<ModelDetails>;
  // the exact size of a prompt, without generating anything. only a provider
  // whose tokenizer cannot be had locally offers it - the rest estimate until
  // the first reply reports what was actually counted
  countTokens?(request: ChatRequest): Promise<number>;
}

// handlers declare their own argument type, so the parameter here is `never` -
// it is the one shape every handler is assignable to regardless of variance
// rules. Tool arguments arrive as untyped JSON from the model, so the call site
// in modules/thinker.ts is where that gets narrowed.
export type ToolCall = {
  definition: ToolDefinition;
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

// a ChatMessage plus what agentiq needs to remember about one of its own.
// the extra field rides along into the session file, so a resumed conversation
// still knows which of its user messages the agent wrote for itself
export type AgentMessage = ChatMessage & {
  // set by compaction, so nothing downstream has to recognise its notes by
  // what they happen to say
  summary?: boolean;
  // what the user actually typed, when the content also carries the files they
  // mentioned with @ - so the prompt can be offered back without them
  typed?: string;
};

export type ThoughtState = {
  messages: ChatMessage[];
  lastResponse?: ChatChunk;
  // set when the user interrupted generation - the turn is rolled back rather
  // than kept, so the caller needs to know it should hand control back
  interrupted?: boolean;
};

// a skill directory under ~/.agentiq/skills, as its SKILL.md describes it
export type Skill = {
  name: string;
  description: string;
  // the SKILL.md itself, which the model reads when a task calls for it
  path: string;
  directory: string;
};

export type TokenStats = {
  tools: number;
  total: number;
  system: number;
  skills: number;
  messages: number;
  // whether total came from the provider's own count of the prompt rather than
  // from the tokenizer. the parts stay estimates either way, so they will not
  // add up to the total once this is set
  measured: boolean;
};
