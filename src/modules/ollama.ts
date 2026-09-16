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
const modelDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../model'
);

export const makeTokenizer = () => {
  const tokenizer = TokenizerLoader.fromPreTrained({
    tokenizerConfig: JSON.parse(
      readFileSync(resolve(modelDir, 'tokenizer_config.json')).toString()
    ),
    tokenizerJSON: JSON.parse(
      readFileSync(resolve(modelDir, 'tokenizer.json')).toString()
    )
  });

  return (value: string) => tokenizer.encode(value).length;
};

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// handlers return whatever shape suits them, but a tool message needs a string.
// strings pass through untouched - running a file through JSON.stringify would
// hand the model a quoted, escape-mangled blob instead of its contents.
const serializeResult = (result: unknown): string => {
  if (result === undefined || result === null) {
    return 'The tool returned no output.';
  }

  return typeof result === 'string' ? result : JSON.stringify(result);
};

type ThinkerOpts = {
  tools: ToolCall[];
  systemPrompt?: string;
};

export const makeThinker = ({ tools, systemPrompt }: ThinkerOpts) => {
  const tokenizer = makeTokenizer();
  const toolDefs = tools.map((tool) => tool.definition);
  const toolNames = toolDefs.map((toolDef) => toolDef.function.name).join(', ');
  const tokens: TokenStats = {
    messages: 0,
    system: 0,
    tools: 0,
    total: 0
  };
  let turnCount = 0;

  // think() is re-entered with the array it returned last turn, so track which
  // messages have already been charged rather than counting the whole history
  // again every round. the system prompt is accounted for separately below.
  const counted = new WeakSet<Message>();
  const countMessage = (message: Message) => {
    if (message.role === 'system' || counted.has(message)) {
      return 0;
    }

    counted.add(message);

    const cost = tokenizer(message.content ?? '');

    tokens.messages += cost;
    tokens.total += cost;

    return cost;
  };

  log.debug(`Context limit is ${ollama.contextLimit} tokens`);

  if (systemPrompt) {
    const sysPromptCost = tokenizer(systemPrompt);

    log.debug(`System prompt will consume ${sysPromptCost} tokens`);

    tokens.system += sysPromptCost;
    tokens.total += sysPromptCost;
  }

  for (const tool of tools) {
    const toolCost = tokenizer(JSON.stringify(tool.definition));

    log.debug(
      `Definition for ${tool.definition.function.name} will consume ${toolCost} tokens`
    );

    tokens.tools += toolCost;
    tokens.total += toolCost;
  }

  const think = async (lastState: ThoughtState): Promise<ThoughtState> => {
    let messages: Message[] = [...lastState.messages];

    if (systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: systemPrompt }, ...messages];
    }

    turnCount++;

    const response = await client.chat({
      model: ollama.model,
      messages,
      tools: toolDefs,
      // without this ollama falls back to the model default - often 4096 - and
      // silently truncates the prompt, dropping messages the model needs
      options: {
        num_ctx: ollama.contextLimit
      }
    });

    // append response before the tool call results - drop `thinking` so the
    // model's own reasoning is not replayed back to it on every later turn
    const assistantMessage: Message = { ...response.message };

    delete assistantMessage.thinking;

    messages.push(assistantMessage);

    // append tool call results, if any
    for (const toolCall of response.message.tool_calls ?? []) {
      const { name, arguments: args } = toolCall.function;
      const tool = tools.find(
        (candidate) => candidate.definition.function.name === name
      );
      let content: string;

      if (!tool) {
        log.warn(`Asked to use an unknown tool called ${name}`);

        content = `There is no tool called ${name}. The available tools are: ${toolNames}`;
      } else {
        try {
          content = serializeResult(await tool.handler(args as never));
        } catch (error) {
          const message = describeError(error);

          log.error(`The ${name} tool threw an error - ${message}`);

          content = `The ${name} tool failed: ${message}`;
        }
      }

      // every tool call needs a result, even a failed one - leaving one
      // dangling makes the next request an incomplete conversation
      messages.push({
        role: 'tool',
        tool_name: name,
        content
      });
    }

    const turnCost = messages.reduce(
      (total, message) => total + countMessage(message),
      0
    );

    log.debug(`Turn cost ${turnCost} tokens`);

    return {
      lastResponse: response,
      messages
    };
  };

  // drop the conversation from the running totals, leaving the system prompt
  // and tool definitions - they are still sent on every turn
  const reset = () => {
    const freed = tokens.messages;

    tokens.messages = 0;
    tokens.total -= freed;
    turnCount = 0;

    return freed;
  };

  return {
    think,
    reset,
    tokens,
    get turnCount() {
      return turnCount;
    }
  };
};
