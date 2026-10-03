import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { provider } from '../modules/config';
import { Provider, type ChatProvider } from '../types';

// ollama unless anthropic was asked for by name, which is what a config that
// predates the setting expects
export const makeChatProvider = (name: string = provider.name): ChatProvider =>
  name === Provider.Anthropic ? new AnthropicProvider() : new OllamaProvider();

// one connection to whatever serves the model, shared by everything that talks
// to it. it is its own module so that a startup check can reach the provider
// without pulling in the thinker and, through it, every tool
export const chatProvider = makeChatProvider();
