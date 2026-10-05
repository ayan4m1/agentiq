import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { anthropic, provider } from '../modules/config';
import { chatProvider, makeChatProvider } from './index';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { Provider } from '../types';

const configured = provider.name;
const configuredKey = anthropic.apiKey;

// the SDK refuses to build a client with no credentials at all, and the
// developer's own environment is no business of these tests
anthropic.apiKey = 'test-key';

after(() => {
  provider.name = configured;
  anthropic.apiKey = configuredKey;
});

describe('makeChatProvider', () => {
  test('talks to the Anthropic API when asked for it', () => {
    assert.ok(
      makeChatProvider(Provider.Anthropic) instanceof AnthropicProvider
    );
  });

  test('talks to an OpenAI-compatible server when asked for it', () => {
    // the client is built on first use, so no key is needed to make one
    assert.ok(makeChatProvider(Provider.OpenAI) instanceof OpenAIProvider);
  });

  test('talks to ollama when asked for it', () => {
    assert.ok(makeChatProvider(Provider.Ollama) instanceof OllamaProvider);
  });

  test('falls back to ollama when no provider is named', () => {
    assert.ok(makeChatProvider('') instanceof OllamaProvider);
  });

  test('falls back to ollama for a provider it does not know', () => {
    assert.ok(makeChatProvider('gemini') instanceof OllamaProvider);
  });

  test('asks about the configured provider unless told which', () => {
    provider.name = Provider.Anthropic;
    assert.ok(makeChatProvider() instanceof AnthropicProvider);

    provider.name = Provider.OpenAI;
    assert.ok(makeChatProvider() instanceof OpenAIProvider);

    provider.name = Provider.Ollama;
    assert.ok(makeChatProvider() instanceof OllamaProvider);
  });
});

describe('chatProvider', () => {
  test('is built for the provider configured at startup', () => {
    const expected = {
      [Provider.Anthropic]: AnthropicProvider,
      [Provider.OpenAI]: OpenAIProvider,
      [Provider.Ollama]: OllamaProvider
    }[configured];

    assert.ok(chatProvider instanceof (expected ?? OllamaProvider));
  });
});
