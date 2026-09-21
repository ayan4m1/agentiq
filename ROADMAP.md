# Roadmap

<!-- agentiq: long-term memory. Leave the "## Todo" and "## Notes" headings in place. -->

## Todo

- [ ] Run a project check (e.g. `tsc --noEmit` or lint) after each successful write/patch and append only newly introduced diagnostics to the tool result, with a short timeout, output capped by truncate() and a `/check on|off` toggle
- [ ] Recover tool calls a model writes as text (JSON, `<tool_call>` tags or fenced blocks) when `tool_calls` is empty, and dispatch them through validation instead of ending the turn (src/modules/ollama.ts)
- [ ] Add a non-interactive mode (`agentiq -p "<task>" --approve=<mode>`) for scripts, CI and hooks, reusing approval modes and sessions, so model and prompt changes can be benchmarked

## Notes

Do not stub out console.log in tests: some tests rely on the logs actually being printed.
