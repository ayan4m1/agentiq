# agentiq

[![codecov](https://codecov.io/gh/ayan4m1/agentiq/graph/badge.svg?token=ZMpY0vGAjm)](https://codecov.io/gh/ayan4m1/agentiq)

Agentiq is an agentic coding assistant for use with Ollama.

## Installation

> npm install -g @ayan4m1/agentiq

Install the package globally and then you will have `agentiq` available as a binary. Run it with no arguments to start an interactive session.

## Configuration

Settings live in `~/.agentiq/config.yml`, which is created with the defaults the first time agentiq
starts. Set `AQ_HOME` to keep it, along with everything else agentiq stores between runs, somewhere
other than `~/.agentiq`.

```yaml
# a setting left out of the file falls back to its default, and every setting
# can be overridden for a single run by the AQ_* environment variable beside it

logging:
  # debug, info, warn, or error (AQ_LOG_LEVEL)
  level: info
  # prefix log lines with their level and category (AQ_LOG_DETAILED)
  detailed: false
  # log the model's thinking (AQ_LOG_THOUGHTS)
  logThoughts: false

approval:
  # manual, auto, or plan - cycle at runtime with shift+tab or /mode. also the
  # default for `agentiq exec --mode` (AQ_APPROVAL_MODE)
  mode: manual

shell:
  # shell used to run commands - unset uses cmd.exe on Windows, /bin/sh
  # elsewhere (AQ_SHELL)
  # path: /bin/bash
  # milliseconds before a command is killed (AQ_SHELL_TIMEOUT)
  timeout: 120000

ollama:
  # ollama server - unset uses http://127.0.0.1:11434 (AQ_OLLAMA_HOST)
  # host: http://127.0.0.1:11434/
  # only needed behind a proxy that asks for one (AQ_OLLAMA_BEARER_TOKEN)
  # bearerToken: your-token
  # context size in tokens; also changed by /context-limit (AQ_OLLAMA_CONTEXT_LIMIT)
  contextLimit: 131072
  # how long ollama keeps the model loaded; -1 never unloads it, 0 unloads it
  # immediately (AQ_OLLAMA_KEEP_ALIVE)
  keepAlive: 30m
  # milliseconds to wait between turns - raise it only for a metered remote
  # endpoint (AQ_OLLAMA_MIN_TURN_DELAY)
  minTurnDelay: 0
  # how hard a reasoning model thinks - true, false, or high/medium/low. unset
  # lets a thinking-capable model keep its reasoning out of the transcript
  # (AQ_OLLAMA_THINK)
  # think: true
  # send the text a model writes before a tool call back on later turns. off
  # because some renderers (e.g. ollama's gemma one) then stop replying
  # (AQ_OLLAMA_REPLAY_PREAMBLE)
  replayPreamble: false
  # recover tool calls a model writes into its reply as text - XML, <tool_call>
  # tags, or JSON (AQ_OLLAMA_RECOVER_TOOL_CALLS)
  recoverToolCalls: true

session:
  # saved sessions to keep in ~/.agentiq/sessions; 0 keeps them all
  # (AQ_SESSION_LIMIT)
  limit: 50
  # how many of a resumed session's prompts the up arrow reaches back through;
  # 0 for all (AQ_HISTORY_LIMIT)
  historyLimit: 100
  # turns /recap covers when no count is given; 0 for all (AQ_RECAP_TURNS)
  recapTurns: 3

tokenizer:
  # huggingface token for gated or private repos - falls back to HF_TOKEN
  # (AQ_HF_TOKEN)
  # hfToken: hf_...

roadmap:
  # keep long-term goals and notes in ROADMAP.md, and offer the model the
  # add_todo, complete_todo, remove_todo and update_notes tools
  # (AQ_ENABLE_ROADMAP)
  enabled: false

explore:
  # offer the model the explore tool, which answers a question about the
  # codebase in a separate read-only conversation and hands back a short
  # report (AQ_EXPLORE)
  enabled: true
  # rounds of tool calls an exploration gets before it must report
  # (AQ_EXPLORE_ROUNDS)
  rounds: 8
```

| Command                     | Description                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/context`                  | Shows how many tokens the system prompt, skills, tools and messages take up, against the context limit.                                                                                        |
| `/context-limit [tokens]`   | Shows the current context limit or changes it if able, saving the new value to `config.yml`. `AQ_OLLAMA_CONTEXT_LIMIT` still wins when set.                                                    |
| `/mode`                     | Cycles the approval mode between manual, auto and plan (same as shift+tab).                                                                                                                    |
| `/model`                    | Picks an Ollama model and the tokenizer that matches it. See [Choosing a model](#choosing-a-model).                                                                                            |
| `/compact`                  | Summarizes the conversation to free up context.                                                                                                                                                |
| `/recap [turns]`            | Prints a short recap of the last `session.recapTurns` turns, or of `turns` turns. The recap is never added to the conversation.                                                                |
| `/paste`                    | Opens `$VISUAL` or `$EDITOR` (notepad or vim when neither is set) for a multi-line prompt, and sends it when the editor closes.                                                                |
| `/clear`, `/reset`          | Starts a new conversation. The old one stays saved as a session.                                                                                                                               |
| `/resume`                   | Picks a saved session to continue.                                                                                                                                                             |
| `/undo`                     | Takes the conversation back to before the most recent prompt, restoring every file written since.                                                                                              |
| `/changes`                  | Lists the files written this session.                                                                                                                                                          |
| `/check [on\|off\|command]` | After each turn that writes files, runs a test/lint/type-check command (chosen by the model with `on`, or the one given) and shows `✔`/`✘` above the prompt. Alone, shows the current setting. |
| `/rules`                    | Lists saved approval rules (↑↓ to move, `r` then `y` to remove). `/rules add command <pattern>` or `/rules add path <pattern>` saves one; `*` matches within a path segment, `**` across them. |
| `/help`                     | Lists the available commands.                                                                                                                                                                  |
| `/quit`                     | Exits agentiq.                                                                                                                                                                                 |

## Choosing a model

The model agentiq talks to, and the huggingface.co repository whose tokenizer matches it are chosen
with the `/model` command. The command lists models you have configured already - at first, you will have to add a new model to Agentiq. Selecting "Add a new model..." lists what is installed on the Ollama server, asks which repo
the tokenizer comes from, and saves the pair to `~/.agentiq/models.json`:

```json
{
  "active": "gemma4:e4b",
  "models": [{ "model": "gemma4:e4b", "tokenizer": "google/gemma-4-E4B" }]
}
```

The tokenizer can also be a local directory containing `tokenizer.json` and `tokenizer_config.json`,
either relative to `~/.agentiq` (e.g. `./my-tokenizer`) or an absolute path. Nothing is downloaded
for a local directory; it is used as it stands.

Switching mid-conversation keeps the history. The tokenizer is downloaded, the system prompt is
rebuilt around the new model, and the context is counted again from scratch.

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
