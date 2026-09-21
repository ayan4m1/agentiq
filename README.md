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

## Non-interactive use

`agentiq exec` runs a single prompt to completion without asking anything, for short one-off prompts or scripts:

```sh
agentiq exec "fix the failing tests" --mode auto
```

`--mode` (`-m`) picks the approval mode, and defaults to `AQ_APPROVAL_MODE`:

- `auto` - every change is applied without asking.
- `manual` - only changes already allowed by a saved rule (an earlier "always" answer) are applied.
  Everything else is refused, and the model is told nobody was there to approve it.
- `plan` - nothing can be changed. The run ends once the model presents its plan.

Questions the model would normally put to you are answered with a note telling it to decide for
itself. A model has to have been set up with `agentiq run` first.

The run is saved as a session like any other, and its id is printed at the end so it can be picked
up with `agentiq run --resume <id>`. The exit status is `0` when the model finished and `1` when
startup or a model call failed.
