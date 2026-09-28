#!/bin/bash
# Shared start/stop/status control for the local Ollama server.
# Used by both Claude Code's SessionStart/SessionEnd hooks (registered at
# user scope in ~/.claude/settings.json, so this fires for a session started
# from ANY directory on this machine) and the ollama-up/ollama-down/
# ollama-status shell functions in ~/.zshrc for manual control.
#
# Delegates actual process supervision to launchd via `brew services run`/
# `stop`, NOT a manually-backgrounded/nohup'd process — a plain `nohup ... &`
# spawned from a short-lived script gets reaped once its parent process tree
# exits, which doesn't survive a hook invocation. `brew services run` starts
# it via launchd WITHOUT registering it to auto-start at login/boot (that's
# `start`, which we deliberately don't use).
set -u

BREW="/opt/homebrew/bin/brew"

is_up() {
  curl -s -o /dev/null -m 2 http://localhost:11434/api/version
}

case "${1:-}" in
  up)
    if is_up; then
      echo "ollama already running"
      exit 0
    fi
    "$BREW" services run ollama >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if is_up; then
        echo "ollama started"
        exit 0
      fi
      sleep 0.5
    done
    echo "ollama did not respond within 5s" >&2
    exit 1
    ;;
  down)
    if is_up; then
      "$BREW" services stop ollama >/dev/null 2>&1
      echo "stopped ollama"
    else
      echo "ollama not running"
    fi
    ;;
  status)
    if is_up; then
      echo "ollama: up"
    else
      echo "ollama: down"
    fi
    ;;
  *)
    echo "usage: ollama-ctl.sh {up|down|status}" >&2
    exit 1
    ;;
esac
