# agentiq

[![codecov](https://codecov.io/gh/ayan4m1/agentiq/graph/badge.svg?token=ZMpY0vGAjm)](https://codecov.io/gh/ayan4m1/agentiq)

Agentiq is an agentic coding assistant for use with Ollama.

## Installation

> npm install -g @ayan4m1/agentiq

Install the package globally and then you will have `agentiq` available as a binary. Run it with no arguments to start an interactive session.

## Configuration

Settings live in `~/.agentiq/config.yml`, next to everything else agentiq keeps between runs. The
file is created with the defaults the first time agentiq starts. Its sections match the config in
`src/modules/config.ts`:

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
changes it and saves it to `config.yml` for the future. `AQ_OLLAMA_CONTEXT_LIMIT` still overrides the
saved value when it is set.

`/recap` asks the model for a short recap of the last `session.recapTurns` turns (`AQ_RECAP_TURNS`,
default 3), and `/recap <turns>` covers that many instead. The recap is only printed - it is never
added to the conversation or the session file - so it is handy after `/resume` or a compaction.

`/paste` opens `$VISUAL` or `$EDITOR` (notepad or vim when neither is set) for a prompt that spans
more than one line, such as a stack trace, and sends it once the editor is closed. `/undo` can still
take it back.

`/check on` asks the model to pick a command that tests, lints or type-checks the project, then runs
it each time the model finishes a turn that wrote or patched files. Its result shows after the token count above the prompt: `✔`
when it passed, `✘` when it failed (along with the last few lines of its output), and `·` before it
has run. The command goes through the same approval as any other, so plan mode skips it and manual
mode asks first. Check mode starts off in every new session. The chosen command is saved with the
session, so `/resume` brings it back. `/check <command>`, such as `/check yarn lint`, uses that command
instead of asking the model. `/check off` turns it off, and `/check` alone shows what it is set to.

The model can hand an open-ended question about the codebase - "where is the approval mode enforced
for shell commands?" - to the `explore` tool. It is answered in a separate conversation that can only
use `find`, `list`, `read`, `fetch` and `read_plan`, and only the short report it writes comes back,
so the files it read never take up room in the main conversation. Each call it makes is shown on a
line of its own starting with `>`, and escape stops it. It gets `explore.rounds` rounds of tool calls
(`AQ_EXPLORE_ROUNDS`, default 8) before it has to report, and `explore.enabled: false` (`AQ_EXPLORE`)
stops it being offered, for a model that struggles to use it.

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

The tokenizer can also be a local directory containing `tokenizer.json` and `tokenizer_config.json`,
either relative to `~/.agentiq` (e.g. `./my-tokenizer`) or an absolute path. Nothing is downloaded
for a local directory; it is used as it stands.

Switching mid-conversation keeps the history. The tokenizer is downloaded, the system prompt is
built again around the new model, and the context is counted again from scratch.

## Skills

agentiq supports [Agent Skills](https://agentskills.io). Put each skill in its own directory under
`~/.agentiq/skills/`, with a `SKILL.md` whose frontmatter names and describes it:

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when the user mentions a PDF.
---

# Steps

...
```

Skills are read once at startup. Only each skill's name, description and location go into the
system prompt; the model reads the full `SKILL.md` when a task matches it. `/context` shows what the
listing costs on its `SKILLS` line.

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
