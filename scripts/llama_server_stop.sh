#!/usr/bin/env bash
# Stops the llama-server instance started by llama_server_start.sh (or by
# app/serve.py's own auto-managed startup). Only kills the port if the
# process actually listening there is `llama-server` -- won't touch
# anything else that happens to be bound to it.
#
# Usage: ./scripts/llama_server_stop.sh
set -uo pipefail

PORT="${LLAMA_PORT:-8080}"

pid="$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -z "$pid" ]; then
  echo "port $PORT: nothing running"
  exit 0
fi
cmd="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
if [[ "$cmd" != *llama-server* ]]; then
  echo "port $PORT: something else is listening ($cmd) -- leaving it alone"
  exit 0
fi
echo "stopping llama-server on port $PORT (pid $pid)"
kill "$pid"
