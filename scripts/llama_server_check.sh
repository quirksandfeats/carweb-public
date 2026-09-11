#!/usr/bin/env bash
# Health check for the local llama-server instance: is anything listening,
# and does it actually answer a real /v1/chat/completions request with the
# configured model, not just accept a bare TCP connection (GET /health
# alone can say "ready" while the model is still finishing its very first
# load into memory in some edge cases -- a real chat round-trip is the
# strongest signal something is fully working end to end).
#
# Usage: ./scripts/llama_server_check.sh
set -uo pipefail

PORT="${LLAMA_PORT:-8080}"
ALIAS="${LLAMA_MODEL_ALIAS:-qwen3.5-9b-mtp}"

echo "---- port $PORT ----"
if ! lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "  NOT LISTENING -- no process is bound to this port at all"
  echo ""
  echo "  Start it with ./scripts/llama_server_start.sh, or just run app/serve.py"
  echo "  (it manages this automatically)."
  exit 1
fi
pid="$(lsof -i ":$PORT" -sTCP:LISTEN -t | head -1)"
cmd="$(ps -p "$pid" -o comm= 2>/dev/null || echo unknown)"
echo "  listening (pid $pid, process: $cmd)"

health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
echo "  GET /health -> ${health:-no response}"

echo "  sending a real chat request..."
start=$(date +%s)
resp=$(curl -s -m 60 -w "\nHTTP_STATUS:%{http_code}" "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$ALIAS\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ok\"}],\"stream\":false}")
elapsed=$(( $(date +%s) - start ))
status=$(echo "$resp" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)

if [ "$status" = "200" ]; then
  echo "  OK -- answered a real chat request in ${elapsed}s"
else
  echo "  FAILED -- HTTP status: ${status:-none/timeout} after ${elapsed}s"
  echo "  raw response (first 300 chars): $(echo "$resp" | head -c 300)"
fi

# Is the running server actually USING MTP? A server that quietly started
# without the MTP flags answers every request perfectly well -- just at
# ordinary one-token-at-a-time speed while still paying the MTP build's extra
# ~2GB of RAM. That is the one failure here with no visible symptom, so check
# it directly instead of trusting that it must have worked.
echo ""
echo "---- MTP ----"
mtp_line="$(ps -eo args= 2>/dev/null | grep "[l]lama-server" | head -1)"
if [ -z "$mtp_line" ]; then
  echo "  can't tell -- no llama-server process visible (started outside this machine's process list?)"
elif echo "$mtp_line" | grep -q -- "--spec-type draft-mtp"; then
  n="$(echo "$mtp_line" | sed -n 's/.*--spec-draft-n-max \([0-9]*\).*/\1/p')"
  echo "  ON -- speculative decoding active (--spec-draft-n-max ${n:-unset})"
else
  echo "  OFF -- this server is NOT using MTP."
  echo "  If that's unintentional, it's generating at ordinary speed while still"
  echo "  paying the MTP build's extra RAM. Restart it with ./scripts/llama_server_start.sh"
  echo "  (stop the current one first: ./scripts/llama_server_stop.sh)."
fi

echo ""
echo "If NOT LISTENING: llama-server never started -- check llama_logs/llama-server-$PORT.log for why."
echo "If listening but FAILED: it's up but not actually able to serve (still loading/downloading the model, out of memory, or wedged)."
