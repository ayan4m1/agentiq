import { readFileSync } from 'node:fs';
import { Message, Ollama } from 'ollama';
import { TokenizerLoader } from '@lenml/tokenizers';

import { ollama } from './config';
import { getLogger } from './logging';
import { ThoughtState, TokenStats, ToolCall } from '../types';

const log = getLogger('ollama');
const client = new Ollama({
  headers: ollama.bearerToken
    ? {
        Authorization: `Bearer ${ollama.bearerToken}`
      }
    : undefined,
  host: ollama.host
});

export const makeTokenizer = () => {
  const tokenizer = TokenizerLoader.fromPreTrained({
    tokenizerConfig: JSON.parse(
      readFileSync('./model/tokenizer_config.json').toString()
    ),
    tokenizerJSON: JSON.parse(readFileSync('./model/tokenizer.json').toString())
  });

  return (value: string) => tokenizer.encode(value).length;
};

export const makeThinker = (tools: ToolCall[]) => {
  const tokenizer = makeTokenizer();
  const toolDefs = tools.map((tool) => tool.definition);
  const tokens: TokenStats = {
    messages: 0,
    system: 0,
    tools: 0,
    total: 0
  };

  const think = async (lastState: ThoughtState): Promise<ThoughtState> => {
    const tokenCount = tokenizer(
      lastState.messages[lastState.messages.length - 1].content
    );

    tokens.messages += tokenCount;
    tokens.total += tokenCount;

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
        const tokenCount = tokenizer(content);

        tokens.tools += tokenCount;
        tokens.total += tokenCount;

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

  return {
    think,
    tokens
  };
};
