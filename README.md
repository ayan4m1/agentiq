# agentiq

Agentiq is an agentic coding assistant for use with Ollama.

## Choosing a model

The model agentiq talks to, and the huggingface.co repository whose tokenizer matches it are chosen
with the `/model` command. The command lists what is installed on the Ollama server, asks which repo
the tokenizer comes from, and saves the pair to `~/.agentiq/models.json`:

```json
{
  "active": "gemma4:e4b",
  "models": [{ "model": "gemma4:e4b", "tokenizer": "google/gemma-4-E4B" }]
}
```

You will be asked to register a model on first startup.

Switching mid-conversation keeps the history. The tokenizer is downloaded, the system prompt is
built again around the new model, and the context is counted again from scratch.
