import {
  Ollama,
  type ChatResponse,
  type ShowResponse,
  type SystemOneNoulQuestion
} from 'ollama';

import { ollama, provider } from '../modules/config';
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  ChatStream,
  DecisionRequest,
  DecisionResponse,
  ModelDetails,
  ModelSummary
} from '../types';

// built from config unless a test hands one in
const makeClient = () =>
  new Ollama({
    headers: ollama.bearerToken
      ? {
          Authorization: `Bearer ${ollama.bearerToken}`
        }
      : undefined,
    host: ollama.host
  });

// model_info is typed as a Map but arrives as parsed JSON, so it is a plain
// object in practice - handle both rather than betting on either
const entriesOf = (info: ShowResponse['model_info']): [string, unknown][] => {
  if (info instanceof Map) {
    return [...info.entries()];
  }

  return info ? Object.entries(info) : [];
};

// the key is namespaced by architecture - "gemma3.context_length" - so the
// architecture is read first, and any context length will do as a fallback
export const readContextLength = (info: ShowResponse['model_info']) => {
  const entries = entriesOf(info);
  const architecture = entries.find(
    ([key]) => key === 'general.architecture'
  )?.[1];
  const named = entries.find(
    ([key]) => key === `${architecture}.context_length`
  )?.[1];

  if (typeof named === 'number') {
    return named;
  }

  const any = entries.find(
    ([key, value]) =>
      key.endsWith('.context_length') && typeof value === 'number'
  )?.[1];

  return typeof any === 'number' ? any : undefined;
};

// ollama reports its counts on the final chunk only, so the rest carry none
const toChunk = (response: ChatResponse): ChatChunk => {
  const counted =
    response.prompt_eval_count || response.eval_count || response.eval_duration;

  return {
    message: response.message,
    done: response.done,
    ...(counted
      ? {
          usage: {
            promptTokens: response.prompt_eval_count || undefined,
            outputTokens: response.eval_count || undefined,
            outputDurationNs: response.eval_duration || undefined
          }
        }
      : {})
  };
};

export class OllamaProvider implements ChatProvider {
  readonly client: Ollama;

  constructor(client: Ollama = makeClient()) {
    this.client = client;
  }

  get label() {
    return `ollama at ${ollama.host ?? 'its default address'}`;
  }

  // what ollama needs on every call that the request itself does not say
  private options() {
    return {
      keep_alive: ollama.keepAlive,
      // without this ollama falls back to the model default - often 4096 -
      // and silently truncates the prompt, dropping messages the model needs
      options: {
        num_ctx: provider.contextLimit
      }
    };
  }

  async stream(request: ChatRequest): Promise<ChatStream> {
    const responses = await this.client.chat({
      ...request,
      ...this.options(),
      stream: true
    });

    return {
      abort: () => responses.abort(),
      async *[Symbol.asyncIterator]() {
        for await (const response of responses) {
          yield toChunk(response);
        }
      }
    };
  }

  async complete(request: ChatRequest) {
    const response = await this.client.chat({
      ...request,
      ...this.options(),
      stream: false
    });

    return response.message;
  }

  // only reaches a request once its response has started to arrive
  abort() {
    this.client.abort();
  }

  // System One takes its questions as a mapping, so each is keyed by position
  // and read back the same way - the caller only ever sees them in order
  async decide({
    model,
    state,
    questions
  }: DecisionRequest): Promise<DecisionResponse> {
    const keys = questions.map((_, index) => `q${index + 1}`);
    const { answers } = await this.client.systemone({
      model,
      state,
      questions: Object.fromEntries(
        questions.map((instructions, index) => [
          keys[index],
          { type: 'noul', instructions } satisfies SystemOneNoulQuestion
        ])
      ),
      keep_alive: ollama.keepAlive
    });

    return {
      probabilities: keys.map((key) => {
        const answer = answers?.[key];

        return answer?.type === 'noul' ? answer.noul : undefined;
      })
    };
  }

  async listModels(): Promise<ModelSummary[]> {
    const { models } = await this.client.list();

    return models.map((model) => ({
      name: model.name ?? model.model,
      id: model.model ?? model.name
    }));
  }

  async describeModel(model: string): Promise<ModelDetails> {
    const details = await this.client.show({ model });

    return {
      // an older server may not report any
      capabilities: details.capabilities ?? [],
      contextLength: readContextLength(details.model_info)
    };
  }
}
