import OpenAI from 'openai';

import { openai } from '../modules/config';
import { getLogger } from '../modules/logging';
import type {
  ChatChunk,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatStream,
  ChatUsage,
  ModelDetails,
  ModelSummary,
  ModelToolCall,
  ThinkSetting,
  ToolDefinition
} from '../types';

const log = getLogger('openai');

// the SDK will not build a client without a key, but a local server - vLLM or
// llama.cpp started without --api-key - never looks at one. this is sent in
// its place, and is only ever sent to a base URL the user chose
const placeholderKey = 'not-needed';

// a configured key wins over the environment. the OpenAI API itself refuses
// every request without one, so with no base URL it is required up front -
// a clear message now rather than a 401 from the first request
export const makeClient = () => {
  const apiKey = openai.apiKey || process.env.OPENAI_API_KEY;

  if (!apiKey && !openai.baseUrl) {
    throw new Error(
      'openai.apiKey (AQ_OPENAI_API_KEY) or OPENAI_API_KEY is required when openai.baseUrl is not set'
    );
  }

  return new OpenAI({
    apiKey: apiKey || placeholderKey,
    baseURL: openai.baseUrl || undefined
  });
};

// what the conversation's tool results are paired against - the ids of the
// calls the assistant turn before them made
const toolCallIds = (message: ChatMessage) =>
  (message.tool_calls ?? []).flatMap((call) => (call.id ? [call.id] : []));

// a call without an id cannot be answered with a tool message, so it is left
// out, and its result goes back as text instead. the API refuses an assistant
// turn with neither content nor calls, so the caller drops one of those
const toAssistant = (
  message: ChatMessage
): OpenAI.ChatCompletionAssistantMessageParam => {
  const calls = (message.tool_calls ?? []).flatMap((call) =>
    call.id
      ? [
          {
            id: call.id,
            type: 'function' as const,
            function: {
              name: call.function.name,
              arguments: JSON.stringify(call.function.arguments)
            }
          }
        ]
      : []
  );

  return {
    role: 'assistant',
    content: message.content || null,
    ...(calls.length ? { tool_calls: calls } : {})
  };
};

// the conversation as the Chat Completions API wants it. every tool message
// has to follow the assistant turn whose call it answers with nothing between
// them, so a result that cannot be paired with a call is held back and passed
// on as text once the paired ones are done, rather than dropped
export const toMessages = (messages: ChatMessage[]) => {
  const converted: OpenAI.ChatCompletionMessageParam[] = [];
  let answerable = new Set<string>();
  let unpaired: string[] = [];

  const flushUnpaired = () => {
    if (unpaired.length) {
      converted.push({ role: 'user', content: unpaired.join('\n\n') });
    }

    unpaired = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_call_id && answerable.has(message.tool_call_id)) {
        converted.push({
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content: message.content
        });
      } else {
        unpaired.push(
          `Result of ${message.tool_name ?? 'a tool'}:\n${message.content}`
        );
      }

      continue;
    }

    flushUnpaired();

    if (message.role === 'system') {
      converted.push({ role: 'system', content: message.content });
    } else if (message.role === 'assistant') {
      const assistant = toAssistant(message);

      answerable = new Set(toolCallIds(message));

      if (assistant.content || assistant.tool_calls) {
        converted.push(assistant);
      }
    } else {
      converted.push({ role: 'user', content: message.content });
    }
  }

  flushUnpaired();

  return converted;
};

export const toTool = (
  definition: ToolDefinition
): OpenAI.ChatCompletionFunctionTool => ({
  type: 'function',
  function: {
    name: definition.function.name ?? '',
    ...(definition.function.description
      ? { description: definition.function.description }
      : {}),
    parameters: { ...definition.function.parameters, type: 'object' }
  }
});

// a level is reasoning_effort, which the OpenAI API and vLLM both take. a
// plain on or off has no standard field at all - vLLM and llama.cpp read it
// from the chat template's enable_thinking, but the OpenAI API refuses a
// field it does not know, so it is only sent to a server the user pointed at
export const toReasoning = (think?: ThinkSetting) => {
  if (think === undefined) {
    return {};
  }

  if (typeof think !== 'boolean') {
    return { reasoning_effort: think };
  }

  return openai.baseUrl
    ? { chat_template_kwargs: { enable_thinking: think } }
    : {};
};

const toParams = (request: ChatRequest) => ({
  model: request.model,
  messages: toMessages(request.messages),
  ...(request.tools?.length ? { tools: request.tools.map(toTool) } : {}),
  ...toReasoning(request.think)
});

// the reasoning a server separates from the answer has no standard field
// either. vLLM has called it both of these, and llama.cpp uses the first
type WithReasoning = { reasoning_content?: string; reasoning?: string };

const reasoningOf = (value: unknown) => {
  const { reasoning_content, reasoning } = value as WithReasoning;

  return reasoning_content || reasoning || '';
};

// a call as it arrived - its arguments are still the text the model wrote
type RawToolCall = { id: string; name: string; arguments: string };

// arguments that do not parse would be run as something other than what the
// model meant, so the call is dropped rather than guessed at. an empty string
// is a call that takes nothing, which some servers send for one
const parseCall = (call: RawToolCall): ModelToolCall | undefined => {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        // a server that sent no id leaves the call unanswerable by id - see
        // toAssistant
        id: call.id || undefined,
        function: {
          name: call.name,
          arguments: parsed as Record<string, unknown>
        }
      };
    }
  } catch {
    // reported below, along with arguments that parse to something else
  }

  log.warn(
    `Dropped a call to ${call.name} whose arguments were not valid JSON`
  );
};

// the reply in the shape the rest of agentiq speaks. a call cut off by running
// out of tokens may parse as valid input that says something else entirely,
// so none of a truncated reply's calls are run
export const toReply = (
  content: string,
  thinking: string,
  calls: RawToolCall[],
  finishReason?: string | null
): ChatMessage => {
  let parsed: ModelToolCall[] = [];

  if (finishReason === 'length' && calls.length) {
    log.warn(
      `Dropped ${calls.length} tool call(s) from a reply that ran out of tokens`
    );
  } else {
    parsed = calls.flatMap((call) => parseCall(call) ?? []);
  }

  return {
    role: 'assistant',
    content,
    ...(thinking ? { thinking } : {}),
    ...(parsed.length ? { tool_calls: parsed } : {})
  };
};

// the prompt the server counted, which is what the context estimate is
// corrected against. a server that does not report cached tokens leaves them
// undefined, since saying 0 would claim a miss nobody measured
export const toUsage = (usage: OpenAI.CompletionUsage): ChatUsage => {
  const cached = usage.prompt_tokens_details?.cached_tokens;

  return {
    promptTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(cached === undefined || cached === null
      ? {}
      : { cache: { readTokens: cached } })
  };
};

// vLLM says how much a model can read as max_model_len, and llama.cpp as the
// context it was trained on. the OpenAI API says neither
type WithContext = { max_model_len?: number; meta?: { n_ctx_train?: number } };

export const readContextLength = (model: unknown) => {
  const { max_model_len, meta } = model as WithContext;

  return max_model_len ?? meta?.n_ctx_train ?? undefined;
};

export class OpenAIProvider implements ChatProvider {
  // built on first use rather than here: the provider is made as its module
  // loads, and a missing key thrown from there would end the process before
  // preflight could say what was wrong
  private built?: OpenAI;

  // every request still in flight, so abort() can reach all of them - the SDK
  // has no client-wide abort of its own
  private controllers: AbortController[] = [];

  constructor(client?: OpenAI) {
    this.built = client;
  }

  get client() {
    this.built ??= makeClient();

    return this.built;
  }

  get label() {
    return openai.baseUrl
      ? `OpenAI-compatible server at ${openai.baseUrl}`
      : 'OpenAI API';
  }

  private track() {
    const controller = new AbortController();

    this.controllers.push(controller);

    return {
      controller,
      release: () => {
        this.controllers = this.controllers.filter(
          (candidate) => candidate !== controller
        );
      }
    };
  }

  async stream(request: ChatRequest): Promise<ChatStream> {
    const { controller, release } = this.track();
    let chunks;

    try {
      chunks = await this.client.chat.completions.create(
        {
          ...toParams(request),
          stream: true,
          // without this the usage never arrives, and the context estimate
          // is never corrected
          stream_options: { include_usage: true }
        },
        { signal: controller.signal }
      );
    } catch (error) {
      release();
      throw error;
    }

    return {
      abort: () => {
        release();
        controller.abort();
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<ChatChunk> {
        // a call arrives in pieces, each naming the call it belongs to by
        // its position in the reply
        const calls: RawToolCall[] = [];
        let content = '';
        let thinking = '';
        let finishReason: string | null | undefined;
        let usage: OpenAI.CompletionUsage | undefined;

        try {
          for await (const chunk of chunks) {
            usage = chunk.usage ?? usage;

            for (const choice of chunk.choices) {
              const delta = choice.delta;
              const reasoning = reasoningOf(delta);

              finishReason = choice.finish_reason ?? finishReason;

              for (const piece of delta.tool_calls ?? []) {
                const call = (calls[piece.index] ??= {
                  id: '',
                  name: '',
                  arguments: ''
                });

                call.id += piece.id ?? '';
                call.name += piece.function?.name ?? '';
                call.arguments += piece.function?.arguments ?? '';
              }

              if (delta.content) {
                content += delta.content;
                yield {
                  message: { role: 'assistant', content: delta.content }
                };
              }

              if (reasoning) {
                thinking += reasoning;
                yield {
                  message: {
                    role: 'assistant',
                    content: '',
                    thinking: reasoning
                  }
                };
              }
            }
          }

          const reply = toReply(
            content,
            thinking,
            calls.filter(Boolean),
            finishReason
          );

          // the text and the reasoning were streamed already, and the caller
          // adds each chunk to what it has - so the last one carries only
          // what could not be streamed
          yield {
            message: {
              role: 'assistant',
              content: '',
              ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {})
            },
            done: true,
            ...(usage ? { usage: toUsage(usage) } : {})
          };
        } finally {
          release();
        }
      }
    };
  }

  async complete(request: ChatRequest): Promise<ChatMessage> {
    const { controller, release } = this.track();

    try {
      const completion = await this.client.chat.completions.create(
        { ...toParams(request), stream: false },
        { signal: controller.signal }
      );
      const choice = completion.choices[0];
      const message = choice?.message;

      return toReply(
        message?.content ?? '',
        reasoningOf(message ?? {}),
        (message?.tool_calls ?? []).flatMap((call) =>
          call.type === 'function'
            ? [
                {
                  id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments
                }
              ]
            : []
        ),
        choice?.finish_reason
      );
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

  // the id is the name: it is what gets saved and sent back as the model
  async listModels(): Promise<ModelSummary[]> {
    const models: ModelSummary[] = [];

    for await (const model of this.client.models.list()) {
      models.push({ name: model.id, id: model.id });
    }

    return models;
  }

  // read from the list rather than asked for by id: neither vLLM nor llama.cpp
  // serves a model on its own, and only the list carries the context length.
  // nothing is said about capabilities, which preflight takes as unknown
  // rather than as a model that can do nothing
  async describeModel(model: string): Promise<ModelDetails> {
    for await (const candidate of this.client.models.list()) {
      if (candidate.id === model) {
        return {
          capabilities: [],
          contextLength: readContextLength(candidate)
        };
      }
    }

    return { capabilities: [] };
  }
}
