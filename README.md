# agentiq

[![NPM Version](https://img.shields.io/npm/v/%40ayan4m1%2Fagentiq)](https://www.npmjs.com/package/@ayan4m1/agentiq)
[![codecov](https://codecov.io/gh/ayan4m1/agentiq/graph/badge.svg?token=ZMpY0vGAjm)](https://codecov.io/gh/ayan4m1/agentiq)

Agentiq is an agentic coding assistant with support for local and cloud LLM providers.

## Features

- [Support](#providers) for Ollama, Anthropic Messages API, and OpenAI Chat Completions API - a local server that speaks one of the latter two protocols can be used
- Three command/access approval modes - manual, automatic, and planning - with the option to
  [edit](#approving-changes) a proposed change or command in your own editor before approving it
- Saves sessions so they can be resumed later on
- Allowlisting for paths, commands, and tools
- Automatic and manual conversation compaction/summarization
- Get a recap of a resumed session
- [Show the model images](#images) - `@screenshot.png`, the clipboard, or a screenshot from an MCP server
- Run a check command when files are modified, and prefill the prompt with diagnostic logs if the check fails
- [Supports](#skills) Agent Skills
- [Supports](#mcp-servers) MCP
- [Custom commands](#custom-commands) (slash command that turns into a prompt, with arguments interpolated)
- [Support](#the-decide-tool) for System One decision models with Ollama (base model hands a set of questions to decision model)

## Installation

> npm install -g @ayan4m1/agentiq

Install the package globally and then you will have `agentiq` available as a binary. Run it with no arguments to start an interactive session in the current working directory.

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
  # render replies as markdown - false prints the raw text (AQ_RENDER_MARKDOWN)
  renderMarkdown: true

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

provider:
  # which provider serves the model - ollama, anthropic, or openai. see
  # Providers below (AQ_PROVIDER)
  name: ollama
  # context size in tokens; also changed by /context-limit (AQ_CONTEXT_LIMIT)
  contextLimit: 131072
  # milliseconds to wait between turns - raise it only for a metered remote
  # endpoint (AQ_MIN_TURN_DELAY)
  minTurnDelay: 0
  # how hard a reasoning model thinks - true, false, or high/medium/low. unset
  # lets a thinking-capable model keep its reasoning out of the transcript
  # (AQ_THINK)
  # think: true
  # send the text a model writes before a tool call back on later turns. off
  # because some renderers (e.g. ollama's gemma one) then stop replying
  # (AQ_REPLAY_PREAMBLE)
  replayPreamble: false
  # recover tool calls a model writes into its reply as text - XML, <tool_call>
  # tags, or JSON (AQ_RECOVER_TOOL_CALLS)
  recoverToolCalls: true

ollama:
  # ollama server - unset uses http://127.0.0.1:11434 (AQ_OLLAMA_HOST)
  # host: http://127.0.0.1:11434/
  # only needed behind a proxy that asks for one (AQ_OLLAMA_BEARER_TOKEN)
  # bearerToken: your-token
  # how long ollama keeps the model loaded; -1 never unloads it, 0 unloads it
  # immediately (AQ_OLLAMA_KEEP_ALIVE)
  keepAlive: 30m

anthropic:
  # the key used when provider.name is anthropic - empty falls back to the
  # ANTHROPIC_API_KEY environment variable (AQ_ANTHROPIC_API_KEY)
  apiKey: ''
  # a server speaking the Messages API, e.g. sglang - empty falls back to the
  # ANTHROPIC_BASE_URL environment variable, then the Anthropic API
  # (AQ_ANTHROPIC_BASE_URL)
  baseUrl: ''
  # how long the repeated start of each request stays cached - 5m, 1h, or off
  # for a server that refuses cache_control (AQ_ANTHROPIC_PROMPT_CACHE)
  promptCache: 5m

openai:
  # a server speaking the Chat Completions API, e.g. vLLM or llama.cpp - empty
  # uses the OpenAI API (AQ_OPENAI_BASE_URL)
  baseUrl: ''
  # the key used when provider.name is openai - required when baseUrl is empty,
  # optional otherwise. empty falls back to the OPENAI_API_KEY environment
  # variable (AQ_OPENAI_API_KEY)
  apiKey: ''

ceramic:
  # key for the Ceramic web search API - the search tool is offered only once
  # this is set. empty falls back to CERAMIC_API_KEY (AQ_CERAMIC_API_KEY)
  apiKey: ''
  # searches the model may make in answer to one message; 0 means no limit
  # (AQ_CERAMIC_PER_TURN_LIMIT)
  perTurnLimit: 8

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

decide:
  # the System One model the decide tool asks yes/no questions of - the tool is
  # offered only with the ollama provider, once this is set (AQ_DECIDE_MODEL)
  # model: kev-9b

mcp:
  # offer the model the tools of the MCP servers below (AQ_MCP)
  enabled: true
  # milliseconds each server gets to start and list its tools (AQ_MCP_TIMEOUT)
  timeout: 30000
  # servers:
  #   everything:
  #     # false leaves the server out without losing its settings - /mcp
  #     # edits this
  #     enabled: true
  #     command: npx
  #     args: ['-y', '@modelcontextprotocol/server-everything']
  #   docs:
  #     url: https://example.com/mcp

skills:
  # skills to leave out of the prompt, by name - /skills edits this
  # disabled: []
```

## Providers

`provider.name` (or `AQ_PROVIDER` for a single run) picks what serves the model. It is read once at
startup, and decides:

- which server agentiq checks before the first prompt - an unreachable server, or a configured
  model it does not have, stops startup with the list of models it does have
- which models `/model` offers, and which half of `~/.agentiq/models.yml` is used - each provider
  keeps its own saved models and remembers the one it last used, so switching providers does not
  lose either list (see [Choosing a model](#choosing-a-model))
- where every turn, `/compact`, `/recap` and the explore tool send their requests

The choices are:

- `ollama` (the default) - talks to an Ollama server at `ollama.host`. A tokenizer matching your model
  is optional: without one, the context is estimated until the first reply and then corrected with the
  count Ollama reports after every reply. With one, `/context` and the auto-compaction threshold are
  accurate from the start.

> [!NOTE]
> `replayPreamble` and `recoverToolCalls` used to live under `ollama`. A `config.yml` that still
> sets them there, or the old `AQ_OLLAMA_REPLAY_PREAMBLE` and `AQ_OLLAMA_RECOVER_TOOL_CALLS`
> variables, goes on working. When both are set, the `provider` section wins over the `ollama` one,
> and `AQ_REPLAY_PREAMBLE` / `AQ_RECOVER_TOOL_CALLS` win over the old variables. As with every
> setting, an environment variable of either name wins over `config.yml`.

- `anthropic` - talks to the Anthropic Messages API. No tokenizer is needed, since the API counts tokens
  itself.

> [!NOTE]
> The `anthropic` provider needs an API key. Set `anthropic.apiKey` in `config.yml` (or
> `AQ_ANTHROPIC_API_KEY`); left empty, agentiq falls back to the `ANTHROPIC_API_KEY` environment
> variable. Without a key, startup fails because the model list cannot be fetched.
>
> To use another server that speaks the Anthropic Messages API, such as
> [sglang](https://github.com/sgl-project/sglang), set `anthropic.baseUrl` (or
> `AQ_ANTHROPIC_BASE_URL`) to its address, e.g. `http://localhost:30000`.
>
> - Leave `/v1` off the address - the SDK adds `/v1/messages` itself, so
>   `http://localhost:30000/v1` would end up requesting `/v1/v1/messages`.
> - Set `anthropic.apiKey` to any non-empty value. sglang ignores it, but the client will not start
>   without a key.
> - If the server rejects `cache_control`, set `anthropic.promptCache` (or
>   `AQ_ANTHROPIC_PROMPT_CACHE`) to `off`.
> - sglang caches repeated prompt prefixes on its own and ignores `anthropic.promptCache`. It only
>   reports cache reads when launched with `--enable-cache-report` - without it, the debug log
>   shows the prompt cache as not reported by the server.

- `openai` - talks to any server that speaks the OpenAI Chat Completions API, such as
  [vLLM](https://github.com/vllm-project/vllm) or [llama.cpp](https://github.com/ggml-org/llama.cpp),
  or to the OpenAI API itself. No tokenizer is needed, since the API counts tokens
  itself.

> [!NOTE]
> The `openai` provider talks to the OpenAI API unless `openai.baseUrl` (or `AQ_OPENAI_BASE_URL`)
> points it somewhere else. Against the OpenAI API it needs a key: set `openai.apiKey` (or
> `AQ_OPENAI_API_KEY`), or leave it empty to fall back to the `OPENAI_API_KEY` environment
> variable. Without one, startup stops and says so.
>
> To use a server of your own, set `openai.baseUrl` to its address **including `/v1`** - e.g.
> `http://localhost:8000/v1` for vLLM or `http://localhost:8080/v1` for llama.cpp's
> `llama-server`. A key is optional there, and only needed if the server was started with one
> (`--api-key`).
>
> - Start `llama-server` with `--jinja`, or the model's tool calls will not be recognised.
> - `provider.think` set to a level (`low`, `medium`, `high`) is sent as `reasoning_effort`. Set to
>   `true` or `false`, it is sent as `chat_template_kwargs.enable_thinking`, which vLLM and
>   llama.cpp pass to the chat template - but only when `openai.baseUrl` is set, since the OpenAI
>   API refuses it.
> - Reasoning a server separates from the answer (`reasoning_content` or `reasoning`) is kept out of
>   the transcript, like any other provider's.
> - The context length is read from the model list when the server reports it (vLLM's
>   `max_model_len`, llama.cpp's `n_ctx_train`), so `provider.contextLimit` can be checked against it.

`provider.replayPreamble` and `provider.recoverToolCalls` matter most for local models served by
`ollama` or an OpenAI-compatible server, whose chat templates are the usual reason a tool call
ends up written into a reply as text.

## Tools

The model gets things done with the tools below - and with those of any connected
[MCP servers](#mcp-servers), which arrive with names like `mcp__<server>__<tool>`.

| Tool            | Description                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read`          | Reads an existing document, returning its contents with line numbers.                                                                                                          |
| `write`         | Writes a new document. Prefer `patch` for a file that already exists: `write` discards everything not in the content it is given.                                              |
| `patch`         | Replaces exact snippets of text in an existing document - a single replacement, or several applied as one confirmed batch.                                                     |
| `find`          | Finds files by name pattern, and optionally searches their contents.                                                                                                           |
| `list`          | Lists what is in a directory, so the model can get its bearings in an unfamiliar project.                                                                                      |
| `fetch`         | Fetches a document via HTTP, with HTML stripped down to its text.                                                                                                              |
| `search`        | Searches the Web via the Ceramic API, returning the top 10 results as titled links with a snippet.                                                                             |
| `shell`         | Access a shell to run commands, waiting for each to finish.                                                                                                                    |
| `start_job`     | Runs a command in the background and returns straight away - for anything that does not finish on its own, like dev servers, watch builds and log tails.                       |
| `read_job`      | Returns what a background job has printed since the last time it was read. Omit the id to list every job instead.                                                              |
| `stop_job`      | Stops a background job and everything it started.                                                                                                                              |
| `ask_list`      | Asks the user to make a decision from a list of choices.                                                                                                                       |
| `present_plan`  | Shows the user a plan and asks permission to start work.                                                                                                                       |
| `read_plan`     | Returns the most recent plan shown with `present_plan`.                                                                                                                        |
| `explore`       | Answers an open-ended question about the codebase by investigating it in a separate, read-only conversation, and hands back a short report of the relevant paths and snippets. |
| `add_todo`      | Adds an objective to the todo list in `ROADMAP.md`.                                                                                                                            |
| `complete_todo` | Marks an objective on the `ROADMAP.md` todo list as done, checked off as a record.                                                                                             |
| `remove_todo`   | Deletes an objective from `ROADMAP.md` outright.                                                                                                                               |
| `update_notes`  | Writes to the Notes section of `ROADMAP.md`.                                                                                                                                   |
| `decide`        | Asks a fast decision model how likely each of one or more yes/no questions is to be true.                                                                                      |

- `search` is only offered once `ceramic.apiKey` (or `AQ_CERAMIC_API_KEY` / `CERAMIC_API_KEY`) is
  set, and refuses after `ceramic.perTurnLimit` searches (8 by default) until the next message.
- `explore` is only offered when `explore.enabled` is set (the default).
- The roadmap tools - `add_todo`, `complete_todo`, `remove_todo` and `update_notes` - are only
  offered when `roadmap.enabled` is set.
- `decide` is only offered with the `ollama` provider, once `decide.model` is set - see
  [The decide tool](#the-decide-tool).

## Commands

| Command                     | Description                                                                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/context`                  | Shows how many tokens the system prompt, skills, tools and messages take up, against the context limit.                                                                                                                                                                                            |
| `/context-limit [tokens]`   | Shows the current context limit or changes it if able, saving the new value to `config.yml`. `AQ_CONTEXT_LIMIT` still wins when set.                                                                                                                                                               |
| `/mode`                     | Cycles the approval mode between manual, auto and plan (same as shift+tab).                                                                                                                                                                                                                        |
| `/model`                    | Picks a model to use for the current session. See [Choosing a model](#choosing-a-model).                                                                                                                                                                                                           |
| `/compact`                  | Summarizes the conversation to free up context.                                                                                                                                                                                                                                                    |
| `/recap [turns]`            | Prints a short recap of the last `session.recapTurns` turns, or of `turns` turns. The recap is never added to the conversation.                                                                                                                                                                    |
| `/paste`                    | Opens `$VISUAL` or `$EDITOR` (notepad or vim when neither is set) for a multi-line prompt, and sends it when the editor closes.                                                                                                                                                                    |
| `/image [prompt]`           | Attaches the image on the clipboard. With a prompt, sends the two together; alone, holds the image for the next prompt. See [Images](#images).                                                                                                                                                     |
| `/clear`, `/reset`          | Starts a new conversation. The old one stays saved as a session.                                                                                                                                                                                                                                   |
| `/resume`                   | Picks a saved session to continue.                                                                                                                                                                                                                                                                 |
| `/undo`                     | Takes the conversation back to before the most recent prompt, restoring every file written since.                                                                                                                                                                                                  |
| `/changes`                  | Lists the files written this session.                                                                                                                                                                                                                                                              |
| `/check [on\|off\|command]` | After each turn that writes files, runs a test/lint/type-check command (chosen by the model with `on`, or the one given) and shows `✔`/`✘` above the prompt. On a failure, the next prompt is pre-filled with a fix request that sends the check's output along. Alone, shows the current setting. |
| `/rules`                    | Lists saved approval rules (↑↓ to move, `r` then `y` to remove). `/rules add command\|path\|tool <pattern>` saves one; `*` matches within a path segment, `**` across them.                                                                                                                        |
| `/skills`                   | Lists installed skills to turn on or off (↑↓ to move, space to toggle, `a` for all/none, esc or ⏎ to close). Only enabled skills go into the system prompt; the choice is saved to `skills.disabled` in `config.yml`.                                                                              |
| `/mcp`                      | Lists the configured MCP servers, whether each connected, and how many tools it offers (↑↓ to move, space to turn a server on or off, `r` to retry one that failed, esc or ⏎ to close). The choice is saved to `mcp.servers.<name>.enabled` in `config.yml`. See [MCP servers](#mcp-servers).      |
| `/help`                     | Lists the available commands, including [custom commands](#custom-commands).                                                                                                                                                                                                                       |
| `/quit`                     | Exits agentiq.                                                                                                                                                                                                                                                                                     |

## Images

For models that can see images as well as text:

- Mention an image with `@`, as in `what is wrong in @shot.png?`, to attach the image itself rather
  than its bytes as text. `.png`, `.jpg`, `.jpeg` and `.webp` files are attached this way.
- `/image` attaches a screenshot straight from the clipboard. It is read with PowerShell on Windows,
  `osascript` on macOS, and `wl-paste` or `xclip` on Linux.
- An image an [MCP server](#mcp-servers) returns, such as a browser's screenshot, goes to the model
  along with the text of the result.

Each provider is sent images in its own format. An image over 5 MB is not attached. When the model
reports that it cannot take images, agentiq warns you but still sends them. That covers an Ollama
model without the `vision` capability, an Anthropic model without image input; an OpenAI-compatible
server says nothing about its models. Older tool results are dropped from context along with their
images, since an image costs far more than the text beside it.

## Approving changes

In manual mode, every file change, command and MCP tool call waits for an answer:

| Answer        | Effect                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| `y`, `yes`    | Go ahead, this once.                                                                      |
| `n` or enter  | Refuse. You are asked why, and whatever you type is passed on to the model.               |
| `a`, `always` | Go ahead, and save a rule so the same command, path or tool is not asked about again.     |
| `s`, `stop`   | Refuse and hand the keyboard back to you instead of letting the model try something else. |
| `e`, `edit`   | Open the proposal in your editor first (`write`, `patch`, `shell` and `start_job` only).  |

shift+tab cycles the [approval mode](#configuration) from any of these prompts; landing on auto
approves the change on screen.

`e` opens `$VISUAL` or `$EDITOR` (notepad or vim when neither is set, as with `/paste`) on the
whole file as it would be written - for `patch`, with the patch already applied - or on the command
line. A file opens under its own extension, so the editor highlights it. When you save and close
it, the diff (or the command) is shown again and you are asked again: saving is not approval, so
`n` still backs out, and `e` edits your edit.

- What you approve is what is written or run, and the model is told: after a file edit it gets a
  diff of your changes to what it proposed, and after a command edit it is told which command
  actually ran.
- Line endings are kept: a CRLF file stays CRLF, and a final newline the editor adds to a file
  that had none is dropped.
- `a` after editing a command saves the edited command as the rule, since that is what ran.
- An edited file can be rolled back with `/undo` like any other write.

## Choosing a model

The model agentiq talks to and its matching tokenizer are chosen with the `/model` command. The command lists models you have configured already - at first, you will have to add a new model to Agentiq. Selecting "Add a new model..." lists the models the provider serves, asks which repo the tokenizer comes from (Ollama only, and optional - leave it blank to estimate instead), and saves the entry to `~/.agentiq/models.yml`. Models are kept per provider, so each one remembers its own list and the model it last used:

```yaml
active:
  ollama: gemma4:e4b
  anthropic: claude-opus-5-5
  openai: Qwen/Qwen3-Coder-30B-A3B-Instruct
models:
  ollama:
    - model: gemma4:e4b
      tokenizer: google/gemma-4-E4B
  anthropic:
    - model: claude-opus-5-5
  openai:
    - model: Qwen/Qwen3-Coder-30B-A3B-Instruct
```

Anthropic and OpenAI models have no tokenizer entry - the Anthropic API counts tokens itself, and an OpenAI-compatible server reports what it counted after every reply. An Ollama model saved without a tokenizer works the same way, relying on the count Ollama reports.

The tokenizer can be a huggingface.co model (formatted like `user/repo`) or a local directory containing `tokenizer.json` and `tokenizer_config.json`, either as an absolute path or relative to `~/.agentiq` (e.g. `./my-tokenizer`).

Switching mid-conversation keeps the history. Any tokenizer is downloaded, the system prompt is
rebuilt around the new model, and the context is counted again from scratch.

## Custom commands

A prompt you send often can be saved as a command of its own. Each markdown file in
`~/.agentiq/commands/`, or in `.agentiq/commands/` in the directory agentiq runs in, becomes a
slash command named for the file, so `~/.agentiq/commands/review.md` is sent with `/review`:

```markdown
---
description: Review uncommitted changes for bugs
---

Run `git diff` and review the changes for correctness bugs. Focus on: $ARGUMENTS
```

- `$ARGUMENTS` is replaced with everything typed after the name, and `$1` to `$9` with each word
  of it. When the prompt has neither, whatever was typed is added below it.
- The frontmatter is optional. Its `description` is shown beside the command in `/help`.
- A project's command replaces a global one of the same name. A built-in command always wins over
  a file named for it.
- Files mentioned with `@` in the prompt are attached just as when typed.
- Commands are read again before every prompt, so a new or edited one works straight away, and
  they tab-complete like the built-in ones.
- `agentiq exec "/review failing tests"` runs a saved command headlessly.

## Skills

agentiq supports [Agent Skills](https://agentskills.io). Put each skill in its own directory under
`~/.agentiq/skills/`, or under `.agentiq/skills/` in the directory agentiq runs in, with a
`SKILL.md` whose frontmatter names and describes it:

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when the user mentions a PDF.
---

# Steps

...
```

Only each skill's name, description and location go into the system prompt; the model reads the
full `SKILL.md` when a task matches it. `/context` shows what the listing costs on its `SKILLS`
line.

- A project's skill replaces a global one of the same name, so a repository can ship skills of its
  own - release steps, conventions for its stack - alongside the ones you keep for every project.
- Skills are read again before every prompt and when `/skills` opens, so one added or edited
  mid-session is offered from the next message on. The system prompt is only rebuilt when the
  skills actually changed.

Every installed skill starts out enabled. `/skills` turns individual skills off without deleting
them: a disabled skill stays where it is, but its name and description are left out of the system
prompt. The change applies from the next turn and is saved under `skills.disabled` in
`config.yml`, so later runs start the same way.

## MCP servers

agentiq can use the tools of any [Model Context Protocol](https://modelcontextprotocol.io) server.
List each one under `mcp.servers` in `config.yml`, either as a command to run over stdio or as the
url of a server speaking streamable HTTP:

```yaml
mcp:
  servers:
    github:
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ghp_...
    docs:
      url: https://example.com/mcp
      headers:
        Authorization: Bearer abc123
```

Servers are started once, at startup, all at the same time. A server that fails to start, or does
not list its tools within `mcp.timeout`, is reported and left out, and `/mcp` shows what became of
each. From `/mcp`, `r` starts a failed server over again, and space turns a server off - stopping
it and taking its tools away - or back on. That is saved as `enabled: false` under the server in
`config.yml`, so it stays off on the next run without losing its settings. Their tools are offered to the model as `mcp__<server>__<tool>`, and `/context` shows what
they cost on its `MCP` line.

Calling an MCP tool always needs approval, like running a command does. Answering "always" saves a
`tool` rule, and `/rules add tool mcp__<server>__*` allows every tool for one server at once. In plan
mode, only tools that their server marks as read-only can be called.

A PNG, JPEG, WebP or GIF image in a tool's result is passed to the model as an image. Any other
content that is not text, such as audio, is named in the result rather than shown.

## The decide tool

The `decide` tool lets the model hand quick judgement calls to a second, much faster model instead
of reasoning through them at length. It uses Ollama's [System One](https://pydantic.dev/docs/ai/models/system-one/) API, which is built for decision models: rather than writing a reply, a System One model reads some
state and scores how likely each of a set of yes/no questions is to be true.

To turn it on, set `decide.model` (or `AQ_DECIDE_MODEL`) to a System One model, such as `kev-9b`,
installed on the same Ollama server:

```yaml
decide:
  model: kev-9b
```

The tool is only offered with the `ollama` provider, once `decide.model` is set, and needs Ollama
v0.35.0 or later. The decision model is kept loaded for `ollama.keepAlive`, like the chat model.

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
