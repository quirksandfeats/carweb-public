#!/usr/bin/env bash
# Starts the local llama-server instance (port 8080 by default) that
# app/serve.py now expects for the LLM generation-check feature. serve.py
# already does this automatically on its own startup -- this script is only
# for running llama-server standalone, e.g. so it can outlive a single
# serve.py run (skip repaying the model's cold-load cost, or a slow
# first-run download, every time you restart serve.py).
#
# Safe to re-run: if something's already listening on the port, this leaves
# it alone rather than double-starting.
#
# Usage:  ./scripts/llama_server_start.sh
# Stop:   ./scripts/llama_server_stop.sh
set -euo pipefail

# Same defaults as app/serve.py's own LLAMA_MODEL/LLAMA_MODEL_ALIAS/
# LLAMA_PORT/LLAMA_PARALLEL/LLAMA_CTX_PER_REQUEST constants -- see that
# file's own comment for why there's a repo spec AND a short alias, and for
# the ctx-size-is-divided-across-parallel-slots gotcha this script accounts
# for below. Override any of these the same way serve.py itself reads them.
MODEL="${LLAMA_MODEL:-unsloth/Qwen3.5-9B-MTP-GGUF:UD-Q4_K_XL}"
ALIAS="${LLAMA_MODEL_ALIAS:-qwen3.5-9b-mtp}"
PORT="${LLAMA_PORT:-8080}"
# Was 3 here while app/serve.py defaulted to 1 -- the two had silently drifted
# apart despite the comment above claiming they matched, so a server started
# by THIS script and one started by serve.py disagreed on slot count and on
# the --ctx-size product derived from it. Same value as serve.py now.
PARALLEL="${LLAMA_PARALLEL:-1}"
CTX_PER_REQUEST="${LLAMA_CTX_PER_REQUEST:-131072}"

# ---- MTP (multi-token prediction) -----------------------------------------
# Mirrors app/serve.py's LLAMA_MTP / LLAMA_SPEC_DRAFT_N_MAX -- see that file's
# own comment block for the full story. Short version: the default model above
# is the -MTP- build of Qwen3.5-9B (same weights, same quant, same answers as
# the plain repo, plus a multi-token-prediction head), and these two flags are
# what actually turn that head on for ~1.5-2x faster generation. LLAMA_MTP=0
# runs the same file as an ordinary model.
MTP="${LLAMA_MTP:-1}"
# 3 -- measured on this machine by qa/qa_mtp_equivalence.py, not guessed.
# Over five real Wikipedia articles at 15 samples per config, all widths 1-6
# gave byte-identical output to the non-MTP baseline (issue #23302 does not
# reproduce here) with zero ungrounded items, and 3 was the speed peak at
# 1.49x (tied with 4, but tighter spread and less memory). Widths 1-2 run at
# or BELOW plain decoding speed. See app/serve.py's comment for the table.
SPEC_DRAFT_N_MAX="${LLAMA_SPEC_DRAFT_N_MAX:-3}"
case "$(echo "$MTP" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off|"") MTP_ON=0 ;;
  *)                 MTP_ON=1 ;;
esac

# MTP does not support -np/--parallel > 1 yet. Clamp rather than hand
# llama-server a combination it will refuse to start on.
if [ "$MTP_ON" = "1" ] && [ "$PARALLEL" -gt 1 ]; then
  echo "note: LLAMA_PARALLEL=$PARALLEL clamped to 1 -- MTP doesn't support multiple slots yet."
  echo "      Set LLAMA_MTP=0 if you'd rather have the concurrent slots than the speedup."
  PARALLEL=1
fi

TOTAL_CTX=$((CTX_PER_REQUEST * PARALLEL))

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../llama_logs"
mkdir -p "$LOG_DIR"

# Real bug report: the model re-downloaded on every restart because neither
# this script nor app/serve.py ever pinned llama.cpp's own `-hf` cache
# location, so it fell back to llama.cpp's OS default -- which resolves
# relative to whatever $HOME the process sees, and can silently differ
# depending on how/where this gets launched from. Pinned here to the exact
# same fixed, project-local directory app/serve.py itself pins (see that
# file's LLAMA_CACHE_DIR comment), so a model downloaded via THIS script and
# one downloaded via serve.py's own auto-managed lifecycle are always the
# same cache, never two different ones. Respects an LLAMA_CACHE you've
# already set yourself.
CACHE_DIR="${LLAMA_CACHE:-$SCRIPT_DIR/../llama_model_cache}"
mkdir -p "$CACHE_DIR"
export LLAMA_CACHE="$CACHE_DIR"

if ! command -v llama-server >/dev/null 2>&1; then
  echo "llama-server isn't on your PATH -- install llama.cpp first (see README.md: brew install llama.cpp, or build from source)." >&2
  exit 1
fi

# Preflight: MTP support landed in llama.cpp on 2026-05-16 (PR #22673), and
# the flag was renamed `--spec-type mtp` -> `--spec-type draft-mtp` on
# 2026-05-13. An llama-server older than that doesn't know --spec-type at all.
# Catching it here turns "server dies on startup, go read the log" into one
# readable line, and names both ways out.
if [ "$MTP_ON" = "1" ]; then
  if ! llama-server --help 2>&1 | grep -q -- "--spec-type"; then
    echo "" >&2
    echo "Your llama-server is too old for MTP: it has no --spec-type flag." >&2
    echo "MTP landed in llama.cpp on 2026-05-16 (PR #22673)." >&2
    echo "" >&2
    echo "  Fix it:    brew upgrade llama.cpp     (or rebuild from source -- see README.md)" >&2
    echo "  Or skip:   LLAMA_MTP=0 ./scripts/llama_server_start.sh" >&2
    echo "             (runs the same model without speculative decoding -- correct, just not faster)" >&2
    echo "" >&2
    exit 1
  fi
fi

if lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "port $PORT: already in use -- leaving it alone (assuming it's already a llama-server)"
  exit 0
fi

echo "starting llama-server on port $PORT (log: llama_logs/llama-server-$PORT.log)..."
echo "model: $MODEL"
if [ "$MTP_ON" = "1" ]; then
  echo "MTP: on (--spec-type draft-mtp --spec-draft-n-max $SPEC_DRAFT_N_MAX)"
else
  echo "MTP: off (LLAMA_MTP=0) -- running the MTP model file as an ordinary model"
fi
echo "model cache dir: $CACHE_DIR"
echo "ctx-size: $TOTAL_CTX total ($CTX_PER_REQUEST per request x $PARALLEL parallel slots)"
# NOTE the ${MTP_ARGS[@]+"${MTP_ARGS[@]}"} spelling at the call site below
# rather than a plain "${MTP_ARGS[@]}": macOS still ships bash 3.2 as
# /bin/bash, and under `set -u` that older bash treats expanding an EMPTY
# array as an unbound variable and aborts. Empty is exactly the LLAMA_MTP=0
# case -- i.e. the fallback path -- so the portable spelling matters here.
MTP_ARGS=()
if [ "$MTP_ON" = "1" ]; then
  MTP_ARGS=(--spec-type draft-mtp --spec-draft-n-max "$SPEC_DRAFT_N_MAX")
fi

nohup llama-server \
  -hf "$MODEL" \
  --alias "$ALIAS" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --parallel "$PARALLEL" \
  --ctx-size "$TOTAL_CTX" \
  --jinja \
  --reasoning off \
  --reasoning-budget 0 \
  ${MTP_ARGS[@]+"${MTP_ARGS[@]}"} \
  > "$LOG_DIR/llama-server-$PORT.log" 2>&1 &
disown

echo ""
echo "waiting for it to come up (this blocks until GET /health returns 200 -- a real first-run download can take minutes; a cached model should be well under a minute)..."
START_TS=$(date +%s)
for i in $(seq 1 300); do
  status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  if [ "$status" = "200" ]; then
    ELAPSED=$(( $(date +%s) - START_TS ))
    echo "ready (took ${ELAPSED}s -- several minutes here means it just downloaded fresh; check '$CACHE_DIR' if that keeps happening on every restart)."
    exit 0
  fi
  sleep 2
done

echo "still not ready after 10 minutes -- check llama_logs/llama-server-$PORT.log for what's going on." >&2
exit 1
