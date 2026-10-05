import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { provider } from '../modules/config';
import { Provider, type ChatProvider } from '../types';

// ollama unless another provider was asked for by name, which is what a config
// that predates the setting expects
export const makeChatProvider = (
  name: string = provider.name
): ChatProvider => {
  switch (name) {
    case Provider.Anthropic:
      return new AnthropicProvider();
    case Provider.OpenAI:
      return new OpenAIProvider();
    default:
      return new OllamaProvider();
  }
};

// one connection to whatever serves the model, shared by everything that talks
// to it. it is its own module so that a startup check can reach the provider
// without pulling in the thinker and, through it, every tool
export const chatProvider = makeChatProvider();
