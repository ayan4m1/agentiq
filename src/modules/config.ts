try {
  process.loadEnvFile();
} catch {
  // If there is no .env file, use the environment as-is
}

import { LoggingConfig, LogLevel, OllamaConfig } from '../types';

export const logging: LoggingConfig = {
  level: (process.env.AQ_LOG_LEVEL || 'info') as unknown as LogLevel
};

export const ollama: OllamaConfig = {
  bearerToken: process.env.AQ_OLLAMA_BEARER_TOKEN,
  host: process.env.AQ_OLLAMA_HOST,
  model: process.env.AQ_OLLAMA_MODEL ?? '',
  contextLimit: parseInt(process.env.AQ_OLLAMA_CONTEXT_LIMIT ?? '131072', 10)
};
