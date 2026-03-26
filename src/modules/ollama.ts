import { Ollama } from 'ollama';

import { ollama } from './config.js';
import { ThoughtState } from 'types/index.js';

const client = new Ollama({
  headers: ollama.bearerToken
    ? {
        Authorization: ollama.bearerToken
      }
    : null,
  host: ollama.host
});

export const performRoundOfThought = async (
  lastState: ThoughtState
): Promise<ThoughtState> => {
  const response = await client.chat({
    model: ollama.model,
    messages: [
      {
        role: '',
        content: ''
      }
    ]
  });

  // todo: digest information into memory

  return {
    memory: lastState.memory,
    messages: [...lastState.messages, response.message]
  };
};
