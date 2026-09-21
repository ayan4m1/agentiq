# Roadmap

<!-- agentiq: long-term memory. Leave the "## Todo" and "## Notes" headings in place. -->

## Todo

- [ ] Run a project check (e.g. `tsc --noEmit` or lint) after each successful write/patch and append only newly introduced diagnostics to the tool result, with a short timeout, output capped by truncate() and a `/check on|off` toggle
- [x] Recover tool calls a model writes as text (JSON, `<tool_call>` tags or fenced blocks) when `tool_calls` is empty, and dispatch them through validation instead of ending the turn (src/modules/ollama.ts)
- [x] Add a non-interactive mode (`agentiq exec "<task>" --mode <mode>`) for scripts, CI and hooks, reusing approval modes and sessions (src/commands/exec.ts)

## Notes

Do not stub out process.stdout.write in tests: some tests rely on the logs actually being printed.
