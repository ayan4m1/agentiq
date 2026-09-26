# agentiq

Agentiq is an agentic coding assistant for use with Ollama.

## Installation

> npm install -g @ayan4m1/agentiq

Install the package globally and then you will have `agentiq` available as a binary. Run it with no arguments to start an interactive session.

## Configuration

Settings live in `~/.agentiq/config.yml`, next to everything else agentiq keeps between runs. The
file is created with the defaults, and a comment explaining each setting, the first time agentiq
starts. After that it is never overwritten. Its sections match the config in `src/modules/config.ts`:

```yaml
logging:
  level: info
approval:
  mode: manual
ollama:
  host: http://127.0.0.1:11434/
  contextLimit: 131072
session:
  limit: 50
```

A setting left out of the file falls back to its default. Every setting can also be overridden for a
single run by the `AQ_*` environment variable named beside it in the file, such as
`AQ_LOG_LEVEL=debug`. `AQ_HOME` moves the whole directory, config file included, somewhere other than
`~/.agentiq`.

In a running session, `/context-limit` shows the current `contextLimit`, and `/context-limit <tokens>`
changes it for the rest of that session without touching the config file.

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

`--mode` (`-m`) picks the approval mode, and defaults to `approval.mode` from the config file:

- `auto` - every change is applied without asking.
- `manual` - only changes already allowed by a saved rule (an earlier "always" answer) are applied.
  Everything else is refused, and the model is told nobody was there to approve it.
- `plan` - nothing can be changed. The run ends once the model presents its plan.

Questions the model would normally put to you are answered with a note telling it to decide for
itself. A model has to have been set up with `agentiq run` first.

The run is saved as a session like any other, and its id is printed at the end so it can be picked
up with `agentiq run --resume <id>`. The exit status is `0` when the model finished and `1` when
startup or a model call failed.
