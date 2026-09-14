import { ChatResponse, Message } from 'ollama';

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

export type ThoughtState = {
  memory: Record<string, string>;
  messages: Message[];
  lastResponse?: ChatResponse;
};
