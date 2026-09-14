import { Message, Ollama } from 'ollama';

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
            required: ['latitude', 'longitude'],
            properties: {
              latitude: {
                type: 'string',
                description: 'The latitude of the location'
              },
              longitude: {
                type: 'string',
                description: 'The longitude of the location'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_location',
          description: 'Gets a latitude and longitude given a location name',
          parameters: {
            type: 'object',
            required: ['location'],
            properties: {
              location: {
                type: 'string',
                description: 'The location name'
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

  // the assistant turn carrying the tool calls has to land before the results
  // it triggered, otherwise the model sees a dangling call with no output
  const messages: Message[] = [...lastState.messages, response.message];

  for (const toolCall of response.message.tool_calls ?? []) {
    const { name, arguments: args } = toolCall.function;
    let content: string;

    switch (name) {
      case 'get_current_time': {
        const { latitude, longitude } = args;
        log.info(`Fetching time at location ${latitude}, ${longitude}`);

        content = JSON.stringify({ time: '1:34 PM' });
        break;
      }
      case 'get_location': {
        const { location } = args;
        log.info(`Geocoding location ${location}`);

        content = JSON.stringify({ latitude: '40', longitude: '-75' });
        break;
      }
      case 'save_memory': {
        const { subject, detail } = args;
        log.info(`Saving memory about ${subject}...`);

        newMemory[subject] = detail;
        content = JSON.stringify({ saved: true });
        break;
      }
      default:
        content = JSON.stringify({ error: `Unknown tool "${name}"` });
    }

    messages.push({
      role: 'tool',
      tool_name: name,
      content
    });
  }

  return {
    memory: newMemory,
    lastResponse: response,
    messages
  };
};
