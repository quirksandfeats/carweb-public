#!/usr/bin/env bash
# SUPERSEDED: this app moved from Ollama to llama.cpp (real user request).
# This file couldn't be deleted from this environment, so it's left behind
# as a pointer rather than removed -- delete it yourself if you'd like it
# gone. Use ./scripts/llama_server_check.sh instead.
set -uo pipefail
echo "This app no longer uses Ollama -- it now runs on llama.cpp (llama-server)." >&2
echo "Use ./scripts/llama_server_check.sh instead (see README.md for full setup)." >&2
exit 1
