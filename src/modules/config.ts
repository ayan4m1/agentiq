import * as dotenv from 'dotenv';

dotenv.config();

import { LoggingConfig, LogLevel, OllamaConfig } from 'types/index.js';

export const logging: LoggingConfig = {
  level: (process.env.AQ_LOG_LEVEL || 'info') as unknown as LogLevel,
  timestampFormat: process.env.AQ_LOG_TIME_FMT
};
export const ollama: OllamaConfig = {
  bearerToken: process.env.AQ_OLLAMA_BEARER_TOKEN,
  host: process.env.AQ_OLLAMA_HOST,
  model: process.env.AQ_OLLAMA_MODEL
};
