import Anthropic from '@anthropic-ai/sdk';

import { anthropic, logging } from '../modules/config';
import { getLogger } from '../modules/logging';
import {
  Provider,
  type ChatChunk,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  type ModelDetails,
  type ModelSummary,
  type ModelToolCall,
  type ThinkSetting,
  type ToolDefinition
} from '../types';

const log = getLogger('anthropic');

// a streamed turn has no request timeout to stay under, so it gets room to
// finish a long answer. a whole reply waited for in one piece is kept smaller,
// so the request returns well inside the SDK's own timeout
const streamMaxTokens = 64000;
const completeMaxTokens = 16000;

// an empty key would stop the SDK looking anywhere else - ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or a profile from `ant auth login` - so only a key
// that was actually set is handed over. the base URL is the same, so an unset
// one still falls back to ANTHROPIC_BASE_URL and then the API itself
const makeClient = () =>
  new Anthropic({
    apiKey: anthropic.apiKey || undefined,
    baseURL: anthropic.baseUrl || undefined
  });

// the blocks a reply is replayed from. only ones this provider wrote are any
// use here - another provider's record of a turn means nothing to the API
const nativeBlocks = (message: ChatMessage) =>
  message.native?.provider === Provider.Anthropic
    ? (message.native.content as Anthropic.ContentBlockParam[])
    : undefined;

const toolUseIds = (blocks: Anthropic.ContentBlockParam[]) =>
  blocks.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));

// a turn that did not come from here - or came from before native was kept -
// is rebuilt from what it said and the calls it made. a call without an id
// cannot be answered with a tool_result, so it stays in the text instead
const rebuildBlocks = (message: ChatMessage): Anthropic.ContentBlockParam[] => [
  ...(message.content
    ? [{ type: 'text' as const, text: message.content }]
    : []),
  ...(message.tool_calls ?? []).flatMap((call) =>
    call.id
      ? [
          {
            type: 'tool_use' as const,
            id: call.id,
            name: call.function.name,
            input: call.function.arguments
          }
        ]
      : []
  )
];

// the conversation as the messages API wants it. the system prompt goes in its
// own field, and every result for a turn's calls goes in the one user message
// that follows it - a result that cannot be paired with a call is passed on as
// text rather than dropped
export const toMessages = (messages: ChatMessage[]) => {
  const system: string[] = [];
  const converted: Anthropic.MessageParam[] = [];
  let answerable = new Set<string>();
  let results: Anthropic.ContentBlockParam[] = [];
  let unpaired: Anthropic.ContentBlockParam[] = [];

  const flushResults = () => {
    if (results.length || unpaired.length) {
      converted.push({ role: 'user', content: [...results, ...unpaired] });
    }

    results = [];
    unpaired = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_call_id && answerable.has(message.tool_call_id)) {
        results.push({
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: message.content
        });
      } else {
        unpaired.push({
          type: 'text',
          text: `Result of ${message.tool_name ?? 'a tool'}:\n${message.content}`
        });
      }

      continue;
    }

    flushResults();

    if (message.role === 'system') {
      system.push(message.content);
    } else if (message.role === 'assistant') {
      const blocks = nativeBlocks(message) ?? rebuildBlocks(message);

      answerable = new Set(toolUseIds(blocks));

      // the API refuses an assistant turn with nothing in it
      if (blocks.length) {
        converted.push({ role: 'assistant', content: blocks });
      }
    } else {
      converted.push({ role: 'user', content: message.content });
    }
  }

  flushResults();

  return { system: system.join('\n\n') || undefined, messages: converted };
};

export const toTool = (definition: ToolDefinition): Anthropic.Tool => ({
  name: definition.function.name ?? '',
  ...(definition.function.description
    ? { description: definition.function.description }
    : {}),
  input_schema: {
    ...definition.function.parameters,
    type: 'object'
  }
});

// left unset, the model does whatever it does by default - adaptive thinking on
// the current ones. a level is how hard to think, which the API takes as effort
export const toThinking = (think?: ThinkSetting) => {
  if (think === undefined) {
    return {};
  }

  if (think === false) {
    return { thinking: { type: 'disabled' as const } };
  }

  // without summarized the thinking arrives as empty text, which is fine when
  // nobody is going to read it
  const thinking = {
    type: 'adaptive' as const,
    ...(logging.logThoughts ? { display: 'summarized' as const } : {})
  };

  return think === true
    ? { thinking }
    : { thinking, output_config: { effort: think } };
};

const toParams = (request: ChatRequest) => {
  const { system, messages } = toMessages(request.messages);

  return {
    model: request.model,
    ...(system ? { system } : {}),
    messages,
    ...(request.tools?.length ? { tools: request.tools.map(toTool) } : {}),
    ...toThinking(request.think)
  };
};

// the reply in the shape the rest of agentiq speaks, with the original blocks
// kept so the next request can send them back untouched
export const toReply = (message: Anthropic.Message): ChatMessage => {
  let blocks: Anthropic.ContentBlock[] = message.content;
  let calls: ModelToolCall[] = blocks.flatMap((block) =>
    block.type === 'tool_use'
      ? [
          {
            id: block.id,
            function: {
              name: block.name,
              arguments: block.input as Record<string, unknown>
            }
          }
        ]
      : []
  );

  // a call cut off part way through - by a refusal, or by running out of
  // tokens - may parse as valid input that says something else entirely, so
  // it is never run. it is dropped from the record too: a tool_use sent back
  // without a result for it is a request the API refuses
  const cutOff =
    message.stop_reason === 'refusal' ||
    (message.stop_reason === 'max_tokens' && calls.length > 0);

  if (cutOff && calls.length) {
    log.warn(
      `Dropped ${calls.length} tool call(s) from a reply that stopped early (${message.stop_reason})`
    );

    blocks = blocks.filter((block) => block.type !== 'tool_use');
    calls = [];
  } else if (message.stop_reason === 'refusal') {
    log.warn('The model declined to answer');
  }

  const text = blocks.flatMap((block) =>
    block.type === 'text' ? [block.text] : []
  );
  const thinking = blocks.flatMap((block) =>
    block.type === 'thinking' && block.thinking ? [block.thinking] : []
  );

  return {
    role: 'assistant',
    content: text.join(''),
    ...(thinking.length ? { thinking: thinking.join('\n\n') } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(blocks.length
      ? { native: { provider: Provider.Anthropic, content: blocks } }
      : {})
  };
};

// the prompt the server actually counted, cached parts included - which is
// what the context estimate is corrected against
const toUsage = ({ usage }: Anthropic.Message) => ({
  promptTokens:
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0),
  outputTokens: usage.output_tokens
});

export class AnthropicProvider implements ChatProvider {
  readonly client: Anthropic;

  // every request still in flight, so abort() can reach all of them - the SDK
  // has no client-wide abort of its own
  private controllers: AbortController[] = [];

  constructor(client: Anthropic = makeClient()) {
    this.client = client;
  }

  get label() {
    return 'Anthropic API';
  }

  private track(controller: AbortController) {
    this.controllers.push(controller);

    return () => {
      this.controllers = this.controllers.filter(
        (candidate) => candidate !== controller
      );
    };
  }

  async stream(request: ChatRequest): Promise<ChatStream> {
    const stream = this.client.messages.stream({
      ...toParams(request),
      max_tokens: streamMaxTokens
    });
    // a stream brings its own controller, so there is nothing to make here
    const release = this.track(stream.controller);

    return {
      abort: () => {
        release();
        stream.abort();
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<ChatChunk> {
        try {
          for await (const event of stream) {
            if (event.type !== 'content_block_delta') {
              continue;
            }

            if (event.delta.type === 'text_delta') {
              yield {
                message: { role: 'assistant', content: event.delta.text }
              };
            } else if (event.delta.type === 'thinking_delta') {
              yield {
                message: {
                  role: 'assistant',
                  content: '',
                  thinking: event.delta.thinking
                }
              };
            }
          }

          const message = await stream.finalMessage();
          const reply = toReply(message);

          // the text and the reasoning were streamed already, and the caller
          // adds each chunk to what it has - so the last one carries only
          // what could not be streamed
          yield {
            message: {
              role: 'assistant',
              content: '',
              ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}),
              ...(reply.native ? { native: reply.native } : {})
            },
            done: true,
            usage: toUsage(message)
          };
        } finally {
          release();
        }
      }
    };
  }

  async complete(request: ChatRequest): Promise<ChatMessage> {
    // a plain request hands back no controller, so it is given one to obey
    const controller = new AbortController();
    const release = this.track(controller);

    try {
      return toReply(
        await this.client.messages.create(
          { ...toParams(request), max_tokens: completeMaxTokens },
          { signal: controller.signal }
        )
      );
    } finally {
      release();
    }
  }

  async countTokens(request: ChatRequest): Promise<number> {
    const controller = new AbortController();
    const release = this.track(controller);
    const params = toParams(request);

    try {
      const { input_tokens } = await this.client.messages.countTokens(
        {
          ...params,
          // the API refuses a request with no messages, which is what a fresh
          // or cleared conversation is. a single character stands in for the
          // first one - a few tokens over, which a budget can live with
          messages: params.messages.length
            ? params.messages
            : [{ role: 'user', content: '.' }]
        },
        { signal: controller.signal }
      );

      return input_tokens;
    } finally {
      release();
    }
  }

  abort() {
    const inFlight = this.controllers;

    this.controllers = [];

    for (const controller of inFlight) {
      controller.abort();
    }
  }

  async describeModel(model: string): Promise<ModelDetails> {
    const details = await this.client.models.retrieve(model);
    const capabilities = details.capabilities;

    return {
      // every model the messages API serves can call tools. thinking is only
      // claimed when it can be adaptive, since that is the only kind asked for
      // - a model that only takes a token budget would refuse it
      capabilities: [
        'tools',
        ...(capabilities?.thinking.types.adaptive.supported
          ? ['thinking']
          : []),
        ...(capabilities?.image_input.supported ? ['vision'] : [])
      ],
      // max_tokens is how much it can write. what it can read is this one
      contextLength: details.max_input_tokens ?? undefined
    };
  }

  // the id is the name: it is what gets saved and sent back as the model, and
  // a display name like "Claude Opus 5" is not one the API would accept
  async listModels(): Promise<ModelSummary[]> {
    const models: ModelSummary[] = [];

    for await (const model of this.client.models.list()) {
      models.push({ name: model.id, id: model.id });
    }

    return models;
  }
}
