// must come first - it populates process.env for every read below
import './env';

import {
  ApprovalConfig,
  ApprovalMode,
  LoggingConfig,
  LogLevel,
  OllamaConfig,
  SessionConfig,
  ShellConfig,
  TokenizerConfig
} from '../types';

export const logging: LoggingConfig = {
  level: (process.env.AQ_LOG_LEVEL || 'info') as unknown as LogLevel
};

// only the starting mode - shift+tab and present_plan move it at runtime, so
// modules/approval.ts owns the live value from here on
export const approval: ApprovalConfig = {
  mode: (process.env.AQ_APPROVAL_MODE || ApprovalMode.Manual) as ApprovalMode
};

// undefined lets execSync pick the platform default - cmd.exe on Windows,
// /bin/sh elsewhere - rather than assuming bash is on PATH
export const shell: ShellConfig = {
  path: process.env.AQ_SHELL || undefined,
  timeout: parseInt(process.env.AQ_SHELL_TIMEOUT ?? '120000', 10)
};

export const ollama: OllamaConfig = {
  bearerToken: process.env.AQ_OLLAMA_BEARER_TOKEN,
  host: process.env.AQ_OLLAMA_HOST,
  model: process.env.AQ_OLLAMA_MODEL ?? '',
  contextLimit: parseInt(process.env.AQ_OLLAMA_CONTEXT_LIMIT ?? '131072', 10),
  // ollama's own default is five minutes, which is short enough that a pause
  // to read something costs a full reload of the model on the next turn
  keepAlive: process.env.AQ_OLLAMA_KEEP_ALIVE ?? '30m'
};

export const session: SessionConfig = {
  limit: parseInt(process.env.AQ_SESSION_LIMIT ?? '50', 10)
};

export const tokenizer: TokenizerConfig = {
  repo: process.env.AQ_HF_TOKENIZER_REPO,
  // HF_TOKEN is the name the huggingface CLI already writes, so honour it
  hfToken: process.env.AQ_HF_TOKEN || process.env.HF_TOKEN
};
