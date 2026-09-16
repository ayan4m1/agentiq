import { ChatResponse, Message, Tool } from 'ollama';

export type ModelConfig = {
  id: string;
  name: string;
  contextLimit?: number;
};

export enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Warning = 'warning',
  Error = 'error'
}

export type LoggingConfig = {
  level: LogLevel;
};

// manual asks before every mutating action, auto asks for none, and plan
// refuses them outright so the model has to propose an approach first
export enum ApprovalMode {
  Manual = 'manual',
  Auto = 'auto',
  Plan = 'plan'
}

export type ApprovalConfig = {
  mode: ApprovalMode;
};

export type ShellConfig = {
  path?: string;
  timeout: number;
};

export type OllamaConfig = {
  host?: string;
  bearerToken?: string;
  model: string;
  contextLimit: number;
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
};
