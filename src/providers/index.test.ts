import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { anthropic, provider } from '../modules/config';
import { chatProvider, makeChatProvider } from './index';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
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

  test('talks to ollama when asked for it', () => {
    assert.ok(makeChatProvider(Provider.Ollama) instanceof OllamaProvider);
  });

  test('falls back to ollama when no provider is named', () => {
    assert.ok(makeChatProvider('') instanceof OllamaProvider);
  });

  test('falls back to ollama for a provider it does not know', () => {
    assert.ok(makeChatProvider('openai') instanceof OllamaProvider);
  });

  test('asks about the configured provider unless told which', () => {
    provider.name = Provider.Anthropic;
    assert.ok(makeChatProvider() instanceof AnthropicProvider);

    provider.name = Provider.Ollama;
    assert.ok(makeChatProvider() instanceof OllamaProvider);
  });
});

describe('chatProvider', () => {
  test('is built for the provider configured at startup', () => {
    assert.ok(
      chatProvider instanceof
        (configured === Provider.Anthropic ? AnthropicProvider : OllamaProvider)
    );
  });
});
