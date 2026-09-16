try {
  process.loadEnvFile();
} catch {
  // If there is no .env file, use the environment as-is
}

import { LoggingConfig, LogLevel, OllamaConfig, ShellConfig } from '../types';

export const logging: LoggingConfig = {
  level: (process.env.AQ_LOG_LEVEL || 'info') as unknown as LogLevel
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
  contextLimit: parseInt(process.env.AQ_OLLAMA_CONTEXT_LIMIT ?? '131072', 10)
};
