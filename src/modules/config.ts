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

// an unrecognised level is not rejected by winston - it silently fails every
// comparison, so nothing is logged at all. fall back rather than go quiet
const toLogLevel = (value?: string) => {
  if (!value) {
    return LogLevel.Info;
  }

  const levels = Object.values(LogLevel);
  const found = levels.find((level) => level === value);

  if (!found) {
    console.warn(
      `Ignoring AQ_LOG_LEVEL "${value}" - expected one of ${levels.join(', ')}`
    );

    return LogLevel.Info;
  }

  return found;
};

export const logging: LoggingConfig = {
  level: toLogLevel(process.env.AQ_LOG_LEVEL)
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
  keepAlive: process.env.AQ_OLLAMA_KEEP_ALIVE ?? '30m',
  minTurnDelay: parseInt(process.env.AQ_OLLAMA_MIN_TURN_DELAY ?? '0', 10),
  think: toThink(process.env.AQ_OLLAMA_THINK),
  replayPreamble: toBoolean(
    process.env.AQ_OLLAMA_REPLAY_PREAMBLE,
    'AQ_OLLAMA_REPLAY_PREAMBLE'
  )
};

export const session: SessionConfig = {
  limit: parseInt(process.env.AQ_SESSION_LIMIT ?? '50', 10)
};

export const tokenizer: TokenizerConfig = {
  repo: process.env.AQ_HF_TOKENIZER_REPO,
  // HF_TOKEN is the name the huggingface CLI already writes, so honour it
  hfToken: process.env.AQ_HF_TOKEN || process.env.HF_TOKEN
};
