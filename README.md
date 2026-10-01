# local-ai

A local offload server so Claude Code can delegate heavy-lifting to a model
running on this Mac (Ollama + `qwen3-coder:30b`), instead of spending your
subscription's tokens on it.

## Components

- **Ollama**, serving `qwen3-coder:30b` at `http://localhost:11434`. It is
  **not** a persistent login service — it starts when a Claude Code session
  starts and stops when it ends (via `SessionStart`/`SessionEnd` hooks in
  `~/.claude/settings.json`), so it's not idling on your Mac when you're not
  using Claude Code. `ollama-ctl.sh` is the shared start/stop/status script
  both the hooks and the manual commands below use, keyed off a PID file
  (`.ollama.pid`) so they don't fight over who started it.
  - Launch/stop/check it yourself any time (e.g. outside a Claude Code
    session) with the shell functions in `~/.zshrc`:
    ```
    ollama-up       # start it
    ollama-down     # stop it
    ollama-status   # check if it's running
    ```
- **`server.mjs`** — an MCP server registered with Claude Code at user scope
  (`claude mcp list` should show `local-ai`). Claude can call these tools on
  its own judgment mid-task:
  - `ask_local` — general Q&A/research, no file access.
  - `summarize_file` — digest a large file/log instead of reading it directly.
  - `search_explain` — ripgrep a directory, local model explains the matches.
  - `local_agent_run` — hands a coding task to the local model as an
    **autonomous agent**: it reads/writes files and runs shell commands
    (build/test/lint) inside a sandboxed `cwd`, iterating until it actually
    validates the result or gives up. This is the one that does real
    build/deploy/test/validate loops locally. It can also start a dev
    server/service in the background, poll it, and GET a local URL to
    confirm a page actually renders before reporting success (see below).
  - `local_ai_status` — check Ollama/model reachability.
- **`cli.mjs`** — same capabilities from your terminal, via the `local-ai`
  shell function added to `~/.zshrc`:
  ```
  local-ai ask "explain what a CRDT is"
  local-ai summarize ./some/huge.log "what errors happened?"
  local-ai search "TODO" ./src
  local-ai agent "add a /health endpoint that returns 200 and run the tests" ./my-project
  local-ai status
  ```
  Open a new terminal (or `source ~/.zshrc`) to pick up the function.

## Safety model for `local_agent_run` / `local-ai agent`

The local agent runs real shell commands on your machine, so it's not a toy:

- File reads/writes are **hard-scoped** to the `cwd` you pass in — it cannot
  resolve a path outside that directory (checked in `lib/tools.mjs`).
- Shell commands run with `cwd` set to that same directory, a 120s timeout,
  and a blocklist for obviously destructive patterns (`sudo`, `rm -rf /`,
  force-push, `dd` to a device, fork bombs, etc.) — but this is a floor, not
  a guarantee. It can still run `npm install`, hit the network, modify git
  history within the repo, etc.
- **Servers/dev pages** go through a separate `start_background` tool
  (detached child process + log file) instead of the blocking `run_shell`,
  so the agent can launch something like `npm run dev` without hanging
  until the 120s timeout. It checks on it with `check_process`/
  `list_processes` and verifies it by actually GETing it with `fetch_url`
  — which is hard-restricted to `localhost`/`127.0.0.1`, so the agent can't
  use it to reach the outside network. Every background process a run
  starts is force-stopped (`SIGTERM`) when that run ends, whether it
  finished, timed out, or errored, so nothing is left running on your Mac
  between tasks.
- Each run is capped at 25 steps / 10 minutes by default (override via
  `max_steps` / `max_minutes` in the MCP call).
- **Point it at a scratch/dev directory or a repo you have clean commits in**,
  and review its diff/report — treat it like a junior dev's PR, not
  ground truth. `finish(success=true)` only means the model believes its own
  build/test run passed.

## Savings log

Every call through `ask_local`, `summarize_file`, `search_explain`, and
`local_agent_run` (from either the MCP tools or the `local-ai` CLI) appends
a line to `savings.jsonl`: what kind of work it was (category) and an
estimated Claude cost avoided, derived from the local model's actual token
counts against Claude Sonnet 5 pricing (`lib/costlog.mjs`) — approximate,
not a billing record.

- `local-ai savings` — terminal summary (total calls, est. $ saved, by category).
- `npm run build:page` — regenerates `docs/index.html`, a static dashboard
  of the same numbers, served via GitHub Pages from `/docs` on `main`.

**Privacy:** `savings.jsonl` is git-ignored and never leaves this machine —
it holds raw task text, file paths, and search patterns, which can reveal
what you're actually working on. Only `docs/index.html` is committed, and
it renders category totals and dollar amounts only (see
`scripts/build-savings-page.mjs`) — never the per-entry `detail` field, a
file path, or anything else that could be traced back to a specific
project or this device.

## Swapping the model

```
ollama pull <other-model>
export LOCAL_AI_MODEL=<other-model>   # or edit lib/ollama.mjs's default
```
Restart the `local-ai` MCP server (Claude Code picks it up on next session,
or run `claude mcp remove local-ai && claude mcp add ...` to force it) for
the new default to take effect there.

## Troubleshooting

- `ollama-status` / `local-ai status` / `local_ai_status` tool — confirms
  Ollama is up and which model is configured.
- `.hook.log` in this directory — output from the SessionStart/SessionEnd
  hooks, if `ollama-up` isn't happening automatically.
- `ollama list` — shows pulled models.
- `claude mcp list` — confirms the `local-ai` MCP server is connected.
- If Ollama isn't auto-starting with new sessions: open `/hooks` once (or
  restart Claude Code) so the config watcher picks up the change to
  `~/.claude/settings.json` — it only watches directories that had a
  settings file when the session started.
