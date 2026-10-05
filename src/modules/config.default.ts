// written to ~/.agentiq/config.yml the first time agentiq runs, and parsed by
// config.ts for the values a hand-edited file leaves out. keeping the one text
// for both means the seeded file cannot disagree with the real defaults. every
// setting can still be overridden for a single run by the AQ_* env var named
// beside it
export const defaultConfig = `# agentiq settings. any value here can be overridden for a single run by the
# AQ_* environment variable named beside it

logging:
  # debug, info, warn, or error (AQ_LOG_LEVEL)
  level: info
  # whether or not to prefix log lines with their level and category
  # (AQ_LOG_DETAILED)
  detailed: false
  # whether or not to log the model's thinking (AQ_LOG_THOUGHTS)
  logThoughts: false

approval:
  # manual, auto, or plan - cycle at runtime with shift+tab. also the default
  # for \`agentiq exec --mode\` (AQ_APPROVAL_MODE)
  mode: manual

shell:
  # leave unset to use the platform default - cmd.exe on Windows, /bin/sh
  # elsewhere (AQ_SHELL)
  # path: /bin/bash
  # milliseconds before a command is killed (AQ_SHELL_TIMEOUT)
  timeout: 120000

provider:
  # which provider serves the model - ollama or anthropic (AQ_PROVIDER)
  name: ollama
  # the context window to fill, in tokens (AQ_CONTEXT_LIMIT)
  contextLimit: 131072
  # milliseconds to wait between turns - 0 for a local server, raise it only
  # for a metered remote endpoint (AQ_MIN_TURN_DELAY)
  minTurnDelay: 0
  # how hard a reasoning model should think - true, false, or high/medium/low.
  # leave unset to let a model that reports a thinking capability separate its
  # reasoning from its answer by default, which keeps it out of the transcript
  # (AQ_THINK)
  # think: true

ollama:
  # leave unset for ollama's own default of http://127.0.0.1:11434
  # (AQ_OLLAMA_HOST)
  # host: http://127.0.0.1:11434/
  # only needed behind a proxy that asks for one (AQ_OLLAMA_BEARER_TOKEN)
  # bearerToken: your-token
  # how long ollama keeps the model loaded; -1 never unloads it, 0 unloads it
  # immediately (AQ_OLLAMA_KEEP_ALIVE)
  keepAlive: 30m
  # whether the text a model writes on its way to a tool call is sent back on
  # the turns that follow. off by default: some renderers - ollama's gemma one
  # among them - read a tool call that arrives with text beside it as a turn
  # already answered, and reply to the tool result with a single end token and
  # nothing else. turn it on to keep that narration in the transcript on a
  # model that handles it, at the cost of the tokens it takes up every turn
  # (AQ_OLLAMA_REPLAY_PREAMBLE)
  replayPreamble: false
  # whether tool calls a model writes into its reply as text are recovered and
  # run - qwen's XML calls when ollama serves it with the wrong template, a
  # <tool_call> tag, or a fenced or bare JSON call. turn it off if a model's
  # replies are mistaken for calls (AQ_OLLAMA_RECOVER_TOOL_CALLS)
  recoverToolCalls: true

anthropic:
  # the key used when provider.name is anthropic. leave it empty to fall back
  # to the ANTHROPIC_API_KEY environment variable (AQ_ANTHROPIC_API_KEY)
  apiKey: ''
  # where the Messages API is served from - point it at any server that speaks
  # it, such as sglang. leave it empty to fall back to the ANTHROPIC_BASE_URL
  # environment variable, then the Anthropic API (AQ_ANTHROPIC_BASE_URL)
  baseUrl: ''
  # how long the repeated start of each request - tools, system prompt and the
  # conversation so far - stays cached, which bills it at a tenth of the input
  # price. 5m, or 1h if you often pause longer between prompts (writing the
  # cache costs 2x instead of 1.25x). off for a server that refuses
  # cache_control (AQ_ANTHROPIC_PROMPT_CACHE)
  promptCache: 5m

session:
  # how many saved sessions to keep in ~/.agentiq/sessions; older ones are
  # deleted at startup. 0 keeps them all (AQ_SESSION_LIMIT)
  limit: 50
  # how many of a resumed session's prompts the up arrow reaches back through.
  # 0 seeds them all (AQ_HISTORY_LIMIT)
  historyLimit: 100
  # how many of the most recent turns /recap covers when no count is given.
  # the recap is only printed, never added to the conversation. 0 covers them
  # all (AQ_RECAP_TURNS)
  recapTurns: 3

tokenizer:
  # needed only for gated or private repos - falls back to HF_TOKEN
  # (AQ_HF_TOKEN)
  # hfToken: hf_...

roadmap:
  # whether agentiq keeps long-term goals and notes in ROADMAP.md, and offers
  # the model the add_todo, complete_todo, remove_todo and update_notes tools
  # (AQ_ENABLE_ROADMAP)
  enabled: false

explore:
  # whether the model is offered the explore tool, which answers a question
  # about the codebase in a separate conversation that can only read, and
  # hands back just a short report (AQ_EXPLORE)
  enabled: true
  # how many rounds of tool calls an exploration gets before it has to write
  # its report (AQ_EXPLORE_ROUNDS)
  rounds: 8

decide:
  # the System One model the decide tool asks yes/no questions of. only offered
  # when provider.name is ollama, and only once this is set - it needs an
  # ollama server with System One support (AQ_DECIDE_MODEL)
  # model: kev-9b

mcp:
  # whether tools from the MCP servers below are offered to the model (AQ_MCP)
  enabled: true
  # milliseconds each server gets to start and list its tools (AQ_MCP_TIMEOUT)
  timeout: 30000
  # each server is either a command run over stdio, or the url of one that
  # speaks streamable HTTP. their tools are offered as mcp__<server>__<tool>
  # servers:
  #   everything:
  #     # false leaves the server out without losing its settings - /mcp
  #     # edits this
  #     enabled: true
  #     command: npx
  #     args: ['-y', '@modelcontextprotocol/server-everything']
  #     env:
  #       SOME_TOKEN: abc123
  #   docs:
  #     url: https://example.com/mcp
  #     headers:
  #       Authorization: Bearer abc123

skills:
  # skills in ~/.agentiq/skills to leave out of the prompt - /skills edits this
  # disabled: []
`;
