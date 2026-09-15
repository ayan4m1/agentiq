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

type ThinkerOpts = {
  tools: ToolCall[];
  systemPrompt?: string;
};

export const makeThinker = ({ tools, systemPrompt }: ThinkerOpts) => {
  const tokenizer = makeTokenizer();
  const toolDefs = tools.map((tool) => tool.definition);
  const tokens: TokenStats = {
    messages: 0,
    system: 0,
    tools: 0,
    total: 0
  };
  let turnCount = 0;

  if (systemPrompt) {
    const sysPromptCost = tokenizer(systemPrompt);

    log.debug(`System prompt will consume ${sysPromptCost} tokens`);

    tokens.system += sysPromptCost;
    tokens.total += sysPromptCost;
  }

  for (const tool of tools) {
    const toolCost = tokenizer(JSON.stringify(tool));

    log.debug(`Tool call definitions will consume ${toolCost} tokens`);

    tokens.tools += toolCost;
    tokens.total += toolCost;
  }

  const think = async (lastState: ThoughtState): Promise<ThoughtState> => {
    const lastMessage =
      lastState.messages[lastState.messages.length - 1].content;
    const tokenCount = tokenizer(lastMessage ?? '');

    log.debug(`Turn cost ${tokenCount} tokens`);

    tokens.messages += tokenCount;
    tokens.total += tokenCount;

    turnCount++;

    if (lastState.messages.length === 1 && systemPrompt) {
      lastState.messages = [
        { role: 'system', content: systemPrompt },
        ...lastState.messages
      ];
    }

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
        if (name === tool.definition.function.name) {
          content = JSON.stringify(await tool.handler(args as never));
          toolFound = true;
          break;
        }
      }

      if (toolFound) {
        messages.push({
          role: 'tool',
          tool_name: name,
          content
        });
      } else if (!toolFound) {
        log.warn(`Asked to use an unknown tool called ${name}`);
      }
    }

    return {
      lastResponse: response,
      messages
    };
  };

  return {
    think,
    tokens,
    turnCount
  };
};
