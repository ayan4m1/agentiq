import { Ollama } from 'ollama';

import { ollama } from './config';
import { getLogger } from './logging';
import { ThoughtState } from '../types';

const log = getLogger('ollama');
const client = new Ollama({
  headers: ollama.bearerToken
    ? {
        Authorization: `Bearer ${ollama.bearerToken}`
      }
    : undefined,
  host: ollama.host
});

export const performRoundOfThought = async (
  lastState: ThoughtState
): Promise<ThoughtState> => {
  const newMemory = {
    ...lastState.memory
  };
  const response = await client.chat({
    model: ollama.model,
    messages: lastState.messages,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description: 'Gets the current time for a specific location',
          parameters: {
            type: 'object',
            required: ['location'],
            properties: {
              location: {
                type: 'string',
                description: 'The location to get time at'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'save_memory',
          description: 'Saves a piece of information for later retrieval',
          parameters: {
            type: 'object',
            required: [],
            properties: {
              subject: {
                type: 'string',
                description: 'The subject of the information to store'
              },
              detail: {
                type: 'string',
                description: 'The information about the subject to store'
              }
            }
          }
        }
      }
    ]
  });

  for (const toolCall of response.message.tool_calls ?? []) {
    switch (toolCall.function.name) {
      case 'get_current_time': {
        const { location } = toolCall.function.arguments;
        log.info(`Fetching time at location ${location}`);

        lastState.messages.push({
          role: 'assistant',
          content: 'The time in Lisbon is 1:34 PM.'
        });
        break;
      }
      case 'save_memory': {
        const { subject, detail } = toolCall.function.arguments;
        log.info(`Saving memory about ${subject}...`);

        newMemory[subject] = detail;
        break;
      }
    }
  }

  return {
    memory: newMemory,
    lastResponse: response,
    messages: [...lastState.messages, response.message]
  };
};
