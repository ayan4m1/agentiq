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
  timestampFormat?: string;
};

export type OllamaConfig = {
  host?: string;
  bearerToken?: string;
  model: string;
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
};

export type ThoughtState = {
  messages: Message[];
  lastResponse?: ChatResponse;
};
