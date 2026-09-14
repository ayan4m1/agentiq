import { Message, Ollama } from 'ollama';

import { ollama } from './config';
import { getLogger } from './logging';
import { ThoughtState, ToolCall } from '../types';

const log = getLogger('ollama');
const client = new Ollama({
  headers: ollama.bearerToken
    ? {
        Authorization: `Bearer ${ollama.bearerToken}`
      }
    : undefined,
  host: ollama.host
});

export const makeThinker = (tools: ToolCall[]) => {
  const toolDefs = tools.map((tool) => tool.definition);

  const think = async (lastState: ThoughtState): Promise<ThoughtState> => {
    const response = await client.chat({
      model: ollama.model,
      messages: lastState.messages,
      tools: toolDefs
    });

    // append response before the tool call results
    const messages: Message[] = [...lastState.messages, response.message];

    // append tool call results, if any
    for (const toolCall of response.message.tool_calls ?? []) {
      const { name, arguments: args } = toolCall.function;
      let content: string = '';
      let toolFound = false;

      // look through registered tools and call handler
      for (const tool of tools) {
        if (name !== tool.definition.function.name) {
          continue;
        }

        content = JSON.stringify(await tool.handler(args as never));
        toolFound = true;
        break;
      }

      if (toolFound) {
        messages.push({
          role: 'tool',
          tool_name: name,
          content
        });
      } else if (!toolFound) {
        log.warn(`Did not find tool with name ${name}`);
      }
    }

    return {
      lastResponse: response,
      messages
    };
  };

  return { think };
};
