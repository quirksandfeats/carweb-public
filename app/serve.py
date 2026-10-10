#!/usr/bin/env python3
"""Local dev server for The Car Web — needed (instead of double-clicking
index.html) only for the LLM generation-check feature. It does three things:

1. Serves this directory as static files, same as `python3 -m http.server`.
2. Proxies POST /api/llm/chat to a local llama.cpp server's
   /v1/chat/completions endpoint, server-to-server. This is the whole point
   of this file: a browser page can't reliably reach http://localhost:8080
   directly (CORS / private-network restrictions vary by browser), but a
   same-origin request from the page to *this* server, which then makes its
   own server-to-server request to llama-server, sidesteps that entirely.

   Real user request (switched from Ollama to llama.cpp): llama-server has
   NATIVE support for handling several concurrent requests against ONE
   loaded copy of the model (`--parallel N` server "slots" with continuous
   batching), unlike the old Ollama-based setup, which needed a whole SEPARATE
   `ollama serve` process -- and its own full copy of the model in RAM/VRAM --
   per concurrent request. That's why this file used to manage a pool of 3
   independent Ollama processes on 3 different ports; llama.cpp does the
   same job with ONE process and ONE port, using LLAMA_PARALLEL server slots
   instead (see the "llama-server lifecycle" section below). The client
   (llm_families.js) still fires off independent checks for different cars
   concurrently -- opening several detail panels in a row, or a relation
   check's cascade discovery, can have several /api/llm/chat requests in
   flight at once -- llama-server's own slot scheduler is what actually
   parallelizes those now, not this proxy.

   This proxy also always requests a STREAMING response from llama-server
   internally (regardless of what the browser asked for) so it can print a
   live, continuously-updating tokens/second readout to THIS terminal (the
   one `python3 serve.py` is running in) while a generation is in progress --
   see "live tokens/sec reporting" below. The browser itself still only ever
   sees a single, complete JSON response per request, exactly like before --
   nothing about the client-facing contract changed, only what happens
   between this proxy and the model.
3. Serves GET/POST /api/llm-families, reading/writing llm_families.json
   directly on disk in this directory. That file holds ONLY the car
   generations the local LLM has discovered/you've confirmed — it is
   completely separate from cars.json/data.js (the DBpedia-built snapshot).
   If anything ever goes wrong, delete the file (or POST {"families":{}} to
   it) and it starts over from nothing; the rest of the app is untouched.
   Every write also regenerates llm_families_data.js, a `<script>`-loadable
   mirror of the same data (same trick as data.js/cars.json) — this is what
   lets a plain double-clicked index.html (no server, file://, can't fetch()
   local JSON) show the exact same confirmed generations as the live,
   serve.py-backed session.
4. Before it starts listening, re-runs the My Database enrichment
   (data_src/build_db_layer.py's enrich()/flag_garage(), same as manually
   running that file standalone) against the CURRENT contents of the "Car
   Database" folder, and rewrites cars.json/data.js if anything changed.
   Previously this only ever happened when you remembered to manually run
   `python3 build_db_layer.py` (or the full build_data.py pipeline) after
   adding a new car folder -- a freshly `git pull`-ed or newly-added Car
   Database entry would silently sit unmatched until that manual step. Runs
   once at startup, not per-request (cheap relative to a folder scan, but
   still no reason to repeat it on every page load); restart serve.py after
   adding a new My Database folder to pick it up. Failures here are logged
   and swallowed rather than blocking startup -- a bad specs.md shouldn't
   take down the whole app when all you wanted was to browse the graph.

5. Manages its own llama-server process: at startup it launches
   `llama-server` (unless something is already answering on LLAMA_PORT, in
   which case that's reused untouched -- see start_llama_server()'s own
   comment), waits until it's actually ready to answer requests (GET
   /health), and on shutdown (Ctrl+C, or any normal exit) stops it, but ONLY
   if this run of serve.py was the one that started it -- a llama-server you
   already had running yourself (a separate terminal, tmux, etc.) is left
   completely alone, both at startup (not re-launched, just reused) and at
   shutdown (not killed). You no longer need to start llama-server by hand
   for the common case -- see scripts/llama_server_start.sh /
   llama_server_stop.sh if you ever want it to outlive a single serve.py run
   (e.g. restarting serve.py repeatedly without repaying the model's
   several-second cold-load cost each time, or so a first-run model download
   isn't tied to serve.py's own lifetime).

Run:  python3 serve.py [port]        (default port 8077)
Requires: `llama-server` (part of llama.cpp -- see README.md for install
          steps) on your PATH. Nothing else -- serve.py starts and stops its
          own llama-server process automatically, downloading the model on
          first run via llama.cpp's own `-hf` mechanism (like `ollama pull`,
          but built into the model-loading step itself, no separate command
          needed). See LLAMA_MODEL/LLAMA_MODEL_ALIAS below for the ONE place
          to change which model this uses.
"""
import atexit
import http.server
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse

DIR = os.path.dirname(os.path.abspath(__file__))
LLM_FAMILIES_PATH = os.path.join(DIR, "llm_families.json")
LLM_FAMILIES_DATA_JS_PATH = os.path.join(DIR, "llm_families_data.js")
# Manual My Database match review (app/db_match.html) -- see
# data_src/build_db_layer.py's own module docstring/load_overrides() for the
# full story on what this file is and why it exists. Same directory and
# same read/write-lock pattern as llm_families.json just above.
DB_MATCH_OVERRIDES_PATH = os.path.join(DIR, "db_match_overrides.json")

# ---------- llama-server lifecycle (start/stop the local process) ----------
# ---- THE one place to change/select the model (nothing else in this
# codebase hardcodes a model) -- two values because llama.cpp's `-hf`
# download spec (a Hugging Face repo[:quant]) and the short "alias" name
# reported over the API/used in requests are different things. Change either
# by editing the defaults below, or via the LLAMA_MODEL/LLAMA_MODEL_ALIAS
# environment variables (e.g. `LLAMA_MODEL=unsloth/Qwen3.5-27B-GGUF:UD-Q4_K_XL
# LLAMA_MODEL_ALIAS=qwen3.5-27b LLAMA_MTP=0 python3 serve.py`) -- no code edit
# needed for a quick on-the-fly swap. Note the LLAMA_MTP=0 in that example:
# the default model below is an -MTP- build, and most other repos are not, so
# swapping to a non-MTP repo means turning MTP off in the same breath (see
# the LLAMA_MTP block just below). These same two values drive the startup `-hf`
# download/load, every chat request's "model" field, and the 502 error hint
# text, so there is nowhere else that needs to know the model.
LLAMA_MODEL = os.environ.get("LLAMA_MODEL", "unsloth/Qwen3.5-9B-MTP-GGUF:UD-Q4_K_XL")
LLAMA_MODEL_ALIAS = os.environ.get("LLAMA_MODEL_ALIAS", "qwen3.5-9b-mtp")
# ---- MTP (multi-token prediction) speculative decoding ---------------------
# Real user request: moved from unsloth/Qwen3.5-9B-GGUF to the -MTP- build of
# the SAME 9B model at the SAME UD-Q4_K_XL quant (identical weights, identical
# 6.14GB file, identical answers) -- the only difference is that the MTP repo
# also ships the extra multi-token-prediction head, which lets llama-server
# draft several tokens per step and verify them in one pass instead of
# decoding strictly one token at a time. Unsloth measures ~1.5-2x faster
# generation from this; because the drafted tokens are VERIFIED against the
# real model rather than trusted, output quality is unchanged, so this is a
# pure speed win when it works.
#
# Three things this costs, all of them real:
#   1. llama.cpp must be new enough. MTP landed in llama.cpp on 2026-05-16
#      (PR #22673), and the flag was renamed `--spec-type mtp` ->
#      `--spec-type draft-mtp` three days earlier on 2026-05-13. An older
#      llama-server rejects the flag outright and refuses to start -- which
#      is the good failure. `scripts/llama_server_start.sh` preflights this
#      explicitly so you get a readable message instead of a stack trace in
#      the log.
#   2. `-np`/`--parallel` > 1 is NOT yet supported with MTP (neither is
#      `--mmproj`, which this app never used). See LLAMA_PARALLEL_EFFECTIVE
#      below for how that is enforced rather than left as a footgun.
#   3. The MTP head costs roughly 2GB more RAM/VRAM than the plain build.
#
# Set LLAMA_MTP=0 to run this exact same model file as an ordinary
# (non-speculative) model -- the weights are fine without the MTP flags, so
# that is the clean fallback if your llama.cpp is too old, if you would
# rather have concurrent slots back, or if you want an A/B speed comparison.
LLAMA_MTP = os.environ.get("LLAMA_MTP", "1").strip().lower() not in ("0", "false", "no", "off", "")
# How many tokens MTP is allowed to draft per step. Higher = more
# speculative work per step, which pays off when the draft is usually
# accepted and costs when it usually isn't.
#
# 3, and that number is MEASURED ON THIS MACHINE, not borrowed. Reproduce
# with `python3 qa/qa_mtp_equivalence.py --source wikipedia --repeats 3`.
# Result from 2026-08-27, over five real Wikipedia articles (G-Class, Golf,
# Dacia Logan, Toyota 86, Peugeot 205), 3 generations per article per config,
# 15 samples per config, baseline pooled over two separate server loads:
#
#   n-max   vs baseline   tok/s   range        speedup
#   (off)   --            27.7    22.3-29.5    1.00x
#   1       IDENTICAL     27.1    23.8-29.1    0.98x  <- no faster than off
#   2       IDENTICAL     25.8    21.8-27.9    0.93x  <- SLOWER than off
#   3       IDENTICAL     41.2    38.0-42.8    1.49x  <- best, and tightest
#   4       IDENTICAL     41.4    33.7-43.6    1.49x  <- tied with 3
#   5       IDENTICAL     33.2    29.0-37.4    1.20x
#   6       IDENTICAL     38.2    34.6-40.1    1.38x
#
# Three things that says.
#
# First: the llama.cpp bug this default was originally set conservatively
# against -- github.com/ggml-org/llama.cpp/issues/23302, draft-mtp diverging
# from baseline at n-max >= 3 on macOS/Metal -- does NOT reproduce here.
# Every width 1-6 produced byte-identical output to the non-speculative
# baseline on all five articles, with a two-run determinism control passing
# first. Same run also found ZERO ungrounded codes/people/related-nameplates
# across 20 extracted generations, so the answers are not just stable, they
# are clean.
#
# Second: low widths are actively WORSE than not using MTP at all. The
# drafting overhead isn't repaid until the window is wide enough to land
# multiple tokens per verify, so n-max 1-2 pays ~2GB of extra RAM to run at
# or below plain decoding speed.
#
# Third: 3 and 4 are statistically tied (each one's median sits inside the
# other's observed range). 3 wins on tie-break for two reasons -- a tighter
# spread (38.0-42.8 vs 33.7-43.6, i.e. more predictable per-request latency)
# and a narrower draft window, which is less memory.
#
# 5 and 6 are NOT tied with them and are genuinely slower: the curve peaks at
# 3-4 and falls off, because a wider window costs more when drafts get
# rejected. This is a real peak, not "bigger is better".
#
# Worth knowing: the same sweep over short synthetic prompts measured only
# 1.33x. Real articles do BETTER (1.49x) because long, schema-constrained
# JSON over a long context is highly predictable, which is exactly the
# condition a speculative decoder's draft-acceptance rate rewards. The
# app's real workload is the favourable case here, not the hard one.
#
# Re-run the harness after any llama.cpp upgrade. Both the bug and the speed
# curve live in the build you have installed, not in the model.
LLAMA_SPEC_DRAFT_N_MAX = int(os.environ.get("LLAMA_SPEC_DRAFT_N_MAX", "3"))
# ---- how far a single click is allowed to cascade -------------------------
# Real user question: "does this code essentially just check the current model
# selected and its directly related models... [or does it also do] yet another
# (unintended) additional nameplate which is related to the nameplate that the
# original model was related to?"
#
# It used to be the latter, without limit. When a related partner turns out to
# hide generations, applying that split runs the same related-car discovery
# over ITS generations, which schedules a check on ITS partners, and so on --
# a single click could walk outward across the graph, one LLM call per hop,
# with nothing but "each car is only ever checked once" to stop it. Measured
# on a deliberate A->B->C->D->E chain: clicking A alone checked and split all
# five.
#
# 1 = the car you clicked, plus the cars its own article directly names.
# A partner discovered beyond that is still LINKED in the graph and still
# fully checkable -- you just have to click it yourself, which keeps the cost
# of any one click predictable. Raise it (or set the CASCADE_MAX_DEPTH
# environment variable) to let one click fill in more of a platform family at
# once; 0 disables the automatic partner check entirely.
CASCADE_MAX_DEPTH = int(os.environ.get("CASCADE_MAX_DEPTH", "7"))
# ---- transitive relationships --------------------------------------------
# Real user request: "if car A and car B are related, and car B and car C are
# related, then car A and C are also related", with the number of hops
# configurable "similar to how there's a setting for picking the number of
# hops for the LLM to perform for the models" -- i.e. this constant, sharing
# CASCADE_MAX_DEPTH's shape and delivery.
#
# Counts INTERMEDIATE cars: 1 = A-B-C, 2 = A-B-C-D, 0 = off. This is the
# DEFAULT; the app's own setting overrides it per browser and persists, so
# changing it there doesn't need a server restart. Kept low because each
# extra hop multiplies both how many proposals appear and how far a single
# wrong link can propagate.
TRANSITIVE_MAX_HOPS = int(os.environ.get("TRANSITIVE_MAX_HOPS", "1"))

LLAMA_HOST = "127.0.0.1"  # loopback only -- same reasoning as the old OLLAMA_HOSTS loopback-only management
LLAMA_PORT = int(os.environ.get("LLAMA_PORT", "8080"))
LLAMA_BASE_URL = f"http://{LLAMA_HOST}:{LLAMA_PORT}"
# Real user request (moved from Ollama's multi-process pool to llama.cpp's
# native --parallel server slots -- see the module docstring's point 2):
# this many requests can generate concurrently against the ONE loaded model.
# llama-server's own --ctx-size is a TOTAL budget divided evenly across
# these slots (confirmed against llama.cpp's own server docs/issue tracker),
# so start_llama_server() below multiplies LLAMA_CTX_PER_REQUEST by this to
# get the --ctx-size value to actually pass -- changing LLAMA_PARALLEL alone
# is safe and automatically keeps each individual request's usable context
# the same size.
LLAMA_PARALLEL = int(os.environ.get("LLAMA_PARALLEL", "1"))
# ...except that MTP does not support more than one slot yet (see LLAMA_MTP
# above). Rather than let a >1 setting silently produce a llama-server that
# refuses to start, MTP wins and the slot count is clamped to 1 here, once,
# so that every downstream consumer -- the --parallel flag, the --ctx-size
# product, and the startup banner -- all agree on the same number. Everything
# still WORKS at one slot: llama-server queues requests past the last free
# slot rather than rejecting them, so the client firing several concurrent
# checks (llm_families.js does exactly that on a cascade) just gets them
# served one after another instead of interleaved. That is the trade: each
# individual generation is ~1.5-2x faster, but they no longer overlap.
LLAMA_PARALLEL_EFFECTIVE = 1 if LLAMA_MTP else LLAMA_PARALLEL
# Per-REQUEST context window (mirrors the old OLLAMA_NUM_CTX) -- kept at
# 131072 rather than raised to qwen3.5's real 256K ceiling for the same
# reason as before: this app's real prompts have never come close to
# needing it (measured well under 8K tokens worst-case), and a bigger
# context means llama-server allocates a bigger KV cache PER SLOT, which
# costs real RAM for no benefit here. Raise it if you have a reason to.
LLAMA_CTX_PER_REQUEST = int(os.environ.get("LLAMA_CTX_PER_REQUEST", "131072"))
# Real bug report (carried over from the Ollama era): a local model call can
# legitimately take minutes, and the naive fix of just raising a single
# whole-response timeout was itself fragile -- see do_POST's own comment for
# why this proxy now reads the model's response one streamed chunk at a
# time instead of all at once, which changes what this timeout actually
# means (time between chunks, not time for the whole response).
LLAMA_TIMEOUT = float(os.environ.get("LLAMA_TIMEOUT", "600"))
# Hard ceiling on how many tokens one call may generate. Real incident: a
# single yes/no platform-relation question ("Mercedes-Benz E-Class (C207) <->
# Mercedes-Benz C") ran for 874 seconds and 32,060 tokens before being killed
# by hand -- the model had stopped answering and started looping, and nothing
# anywhere would ever have stopped it. Every real answer this app asks for is
# a small JSON object; the largest legitimate one (a many-generation split
# with designers and engineers) measures in the hundreds of tokens, so this
# is roughly 5x the worst real case and still ends a runaway in under a
# minute. Applied only when the caller didn't set its own limit.
LLAMA_MAX_TOKENS = int(os.environ.get("LLAMA_MAX_TOKENS", "3000"))
# When a call passes this many tokens it is already far outside anything this
# app legitimately asks for, so the live line says so rather than looking
# like ordinary slow progress.
LLAMA_RUNAWAY_TOKENS = int(os.environ.get("LLAMA_RUNAWAY_TOKENS", "1200"))
# How long to wait for llama-server to become ready at startup. Generous by
# default because, unlike Ollama's separate `ollama pull` step, llama.cpp's
# `-hf` flag downloads the model AS PART OF startup the first time you ever
# run it -- a multi-gigabyte GGUF file on a slow connection can legitimately
# take several minutes before llama-server even starts loading it into
# memory. Every subsequent run is fast (the file's already cached locally).
LLAMA_STARTUP_TIMEOUT = float(os.environ.get("LLAMA_STARTUP_TIMEOUT", "900"))

# Real bug report: after a full first-run download, stopping and restarting
# llama-server (via serve.py, or the start/stop scripts) sometimes downloaded
# the multi-GB model AGAIN instead of reusing it. Root cause: this file never
# pinned llama.cpp's own `-hf` cache location, so it fell back to llama.cpp's
# OS-default -- $LLAMA_CACHE if set, else ~/Library/Caches/llama.cpp on
# macOS, ~/.cache/llama.cpp on Linux. That default IS normally stable across
# runs of the same shell, but resolves relative to whatever $HOME the process
# sees -- if serve.py or the shell scripts ever get launched from a context
# with a different environment than your usual terminal (a different
# terminal app/profile, a double-clicked .command file, Automator, cron,
# etc.), that can silently land on a different cache path each time, so the
# already-downloaded blob just isn't where the new process is looking, and
# `-hf` treats it as never having been downloaded at all. Pinning this to a
# fixed, project-local directory removes that ambiguity entirely: it's
# always the same path no matter how/where this gets launched from, and it's
# easy to go look at directly (`ls -la llama_model_cache/`) to confirm a
# model actually landed there. Respects an LLAMA_CACHE you've already set
# yourself -- this default only applies when you haven't.
LLAMA_CACHE_DIR = os.environ.get("LLAMA_CACHE", os.path.join(DIR, "..", "llama_model_cache"))

# ---------- full data rebuild (data_src/rebuild.sh) ------------------------
# Real user request: a button that rebuilds data.js from scratch, so the
# snapshot date becomes today rather than whenever the file was last baked.
#
# This is now the ONLY way new DBpedia data enters the graph. There used to be
# a live refresh in the browser that patched newly-discovered cars in and left
# data.js alone -- which is why its "built <date>" label never moved. It was
# removed: a second write path that had to reconcile against the bake, the LLM
# overlay and hand edits forever, to find what a rebuild finds anyway.
#
# It takes minutes and needs the internet, so it can't be a plain blocking
# request: the browser would time out long before it finished. Started in a
# background thread here, polled by the page.
# Overridable so the endpoint can be exercised against a stub script instead
# of the real multi-minute harvest -- see qa/qa_serve_rebuild.py. (Learned the
# hard way: pointing a test at the real script rewrites app/data.js,
# app/db_photos/ and the match report for real.)
REBUILD_SCRIPT = os.environ.get(
    "REBUILD_SCRIPT", os.path.abspath(os.path.join(DIR, "..", "data_src", "rebuild.sh")))
_rebuild_lock = threading.Lock()
_rebuild = {"running": False, "step": "", "log": [], "ok": None,
            "started": None, "finished": None, "returncode": None}


def _rebuild_worker(skip_harvest):
    """Run rebuild.sh, streaming its output into _rebuild["log"].

    rebuild.sh prints a "-- <step> --" banner before each phase, which is
    what drives the progress line in the UI -- no separate progress protocol
    to keep in sync with the script.
    """
    cmd = ["bash", REBUILD_SCRIPT] + (["--no-harvest"] if skip_harvest else [])
    try:
        proc = subprocess.Popen(cmd, cwd=os.path.dirname(REBUILD_SCRIPT),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1)
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            with _rebuild_lock:
                _rebuild["log"].append(line)
                # keep the tail only -- this is a progress readout, not an archive
                if len(_rebuild["log"]) > 400:
                    del _rebuild["log"][:-400]
                m = re.match(r"^\s*[\u2500\-]{2,}\s*(.+?)\s*[\u2500\-]{2,}\s*$", line)
                if m:
                    _rebuild["step"] = m.group(1)
            print("rebuild: %s" % line, flush=True)
        rc = proc.wait()
    except Exception as e:
        with _rebuild_lock:
            _rebuild["log"].append("rebuild failed to start: %s" % e)
            _rebuild["ok"] = False
            _rebuild["running"] = False
            _rebuild["finished"] = time.time()
            _rebuild["step"] = "failed"
        return
    with _rebuild_lock:
        _rebuild["returncode"] = rc
        _rebuild["ok"] = (rc == 0)
        _rebuild["running"] = False
        _rebuild["finished"] = time.time()
        _rebuild["step"] = "done" if rc == 0 else "failed"


def _rebuild_status():
    with _rebuild_lock:
        d = dict(_rebuild)
        d["log"] = list(_rebuild["log"])[-40:]
        d["scriptExists"] = os.path.exists(REBUILD_SCRIPT)
        if d["started"]:
            d["elapsed"] = round((d["finished"] or time.time()) - d["started"], 1)
        return d


LOG_DIR = os.path.join(DIR, "..", "llama_logs")
_spawned = None  # (subprocess.Popen, log_file_handle) -- only set if THIS run started it
_pool_lock = threading.Lock()  # guards _spawned + start/stop against double-invocation
_pool_started = False

# Per-request live terminal tokens/sec reporting (real user request) -- see
# do_POST's own comment for how this is actually populated. A single lock
# just around the print() calls themselves (not around whole requests) so
# concurrent checks (LLAMA_PARALLEL > 1) can report progress independently
# without corrupting each other's terminal output -- each request gets its
# own short id prefix and prints full lines (not a single shared
# carriage-return-updated line), since more than one truly-concurrent
# progress readout can't share one line without garbling.
_terminal_lock = threading.Lock()
_request_counter = 0
_request_counter_lock = threading.Lock()


def _next_request_id():
    global _request_counter
    with _request_counter_lock:
        _request_counter += 1
        return f"req-{_request_counter}"


def _print_live(msg):
    with _terminal_lock:
        print(msg)
        sys.stdout.flush()


def _port_open(host, port, timeout=0.3):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _health_status(timeout=2):
    """None = unreachable (connection refused/timeout -- not up at all).
    'loading' = up but still loading the model (GET /health -> 503).
    'ready' = up and ready to serve (GET /health -> 200)."""
    try:
        with urllib.request.urlopen(LLAMA_BASE_URL + "/health", timeout=timeout) as r:
            return "ready" if r.status == 200 else "loading"
    except urllib.error.HTTPError as e:
        return "loading" if e.code == 503 else None
    except (urllib.error.URLError, OSError):
        return None


def _wait_until_ready(timeout_s):
    # Polled rather than a fixed sleep, and distinguishes "not up yet" from
    # "up but still loading the model" so the printed status is actually
    # informative during a slow first-run download instead of just silently
    # waiting. Blocks main() here, before ThreadingHTTPServer starts
    # accepting connections at all, so no browser request can ever reach
    # /api/llm/chat before llama-server is actually ready to answer it.
    deadline = time.monotonic() + timeout_s
    last_status = None
    while time.monotonic() < deadline:
        status = _health_status()
        if status != last_status:
            if status == "loading":
                print("llama-server: up, loading the model (first run downloads it too -- this can take a while)...")
            last_status = status
        if status == "ready":
            return True
        time.sleep(1.0)
    return False


def start_llama_server():
    """Launch `llama-server` if nothing is already answering on LLAMA_PORT,
    then BLOCK until it's actually ready to serve (GET /health -> 200).
    Called once from main(), before the HTTP server starts listening.

    Idempotent and safe to call from a process that didn't start an
    already-running llama-server: a port that's already open (a previous
    serve.py run, a manually-started `llama-server`, etc.) is left untouched
    and just reused -- never re-launched, never assumed to be "ours" to kill
    later. `_spawned` only ever gets set if THIS call actually created the
    process, which is what makes stop_llama_server() safe to call
    unconditionally at shutdown without ever killing something the user was
    already running before serve.py started.
    """
    global _pool_started, _spawned
    with _pool_lock:
        if _pool_started:
            return
        _pool_started = True

        if _port_open(LLAMA_HOST, LLAMA_PORT):
            print(f"llama-server: already up at {LLAMA_BASE_URL} -- reusing it (not ours, won't be stopped on exit)")
        else:
            llama_bin = shutil.which("llama-server")
            if not llama_bin:
                print("llama-server: not on your PATH -- install llama.cpp first (see README.md), "
                      "or set LLAMA_PORT to point at an instance you start yourself.", file=sys.stderr)
                return
            os.makedirs(LOG_DIR, exist_ok=True)
            os.makedirs(LLAMA_CACHE_DIR, exist_ok=True)
            log_path = os.path.join(LOG_DIR, f"llama-server-{LLAMA_PORT}.log")
            log_f = open(log_path, "a", encoding="utf-8")
            total_ctx = LLAMA_CTX_PER_REQUEST * LLAMA_PARALLEL_EFFECTIVE
            cmd = [
                llama_bin,
                "-hf", LLAMA_MODEL,
                "--alias", LLAMA_MODEL_ALIAS,
                "--host", LLAMA_HOST,
                "--port", str(LLAMA_PORT),
                "--parallel", str(LLAMA_PARALLEL_EFFECTIVE),
                "--ctx-size", str(total_ctx),
                "--jinja",  # needed for chat-template features like reasoning control below
                # Real user request: keep Qwen3.5's internal reasoning/thinking
                # pass off, same reasoning as the old Ollama "think": false
                # switch -- this app's own hallucination-guarded system prompts
                # are meant to fully control the output. `--chat-template-kwargs
                # '{"enable_thinking": false}'` was this app's original
                # mechanism for that, but newer llama-server builds print
                # "Setting 'enable_thinking' via --chat-template-kwargs is
                # deprecated. Use --reasoning on / --reasoning off instead" at
                # startup -- confirmed against llama-server's own --help output
                # (`-rea, --reasoning [on|off|auto]`, env LLAMA_ARG_REASONING) --
                # so this now uses that directly. `--reasoning-budget 0` is
                # stacked on top as a second, more forceful layer: rather than
                # just asking the template not to emit a <think> block (which
                # is what --reasoning off does, and which a currently-open
                # llama.cpp bug -- github.com/ggml-org/llama.cpp/issues/20182 --
                # reports as not always reliable for Qwen3.5 specifically), a
                # 0 token budget makes llama-server itself force reasoning to
                # end immediately regardless of what the template/model
                # wants, which is a stronger guarantee for the same goal.
                # Qwen3.5's 9B variant (what LLAMA_MODEL defaults to) already
                # disables reasoning by default per its own model card, so
                # both of these are defense-in-depth, not the only thing
                # standing between this app and a model that reasons out loud.
                "--reasoning", "off",
                "--reasoning-budget", "0",
            ]
            if LLAMA_MTP:
                # Enables the multi-token-prediction head that the -MTP-
                # GGUF ships (see LLAMA_MTP above). Without these two flags
                # the MTP model still loads and answers correctly -- it just
                # decodes one token at a time like any other model, i.e. you
                # pay the extra ~2GB of RAM for the head and get none of the
                # speedup, which is the one genuinely silent failure mode
                # here and why the startup banner below prints MTP state
                # explicitly rather than leaving you to infer it.
                cmd += ["--spec-type", "draft-mtp",
                        "--spec-draft-n-max", str(LLAMA_SPEC_DRAFT_N_MAX)]
            print(f"llama-server: starting (log: {os.path.relpath(log_path, DIR)})...")
            print(f"llama-server: model={LLAMA_MODEL}")
            if LLAMA_MTP:
                print(f"llama-server: MTP speculative decoding ON "
                      f"(--spec-type draft-mtp --spec-draft-n-max {LLAMA_SPEC_DRAFT_N_MAX}) -- "
                      f"needs llama.cpp from 2026-05-16 or newer; set LLAMA_MTP=0 to disable")
                if LLAMA_PARALLEL > 1:
                    print(f"llama-server: NOTE -- LLAMA_PARALLEL={LLAMA_PARALLEL} was clamped to 1: "
                          f"MTP does not support multiple slots yet. Set LLAMA_MTP=0 to get "
                          f"{LLAMA_PARALLEL} concurrent slots back instead.", file=sys.stderr)
            else:
                print("llama-server: MTP speculative decoding OFF (LLAMA_MTP=0) -- "
                      "running the MTP model file as an ordinary model")
            print(f"llama-server: model cache dir = {LLAMA_CACHE_DIR}")
            # Real bug report: without this, llama.cpp fell back to its own
            # OS-default cache path, which can silently differ between runs
            # depending on what launched this process (see LLAMA_CACHE_DIR's
            # own comment above) -- forcing it here, in the CHILD's own env,
            # is what actually makes the pin take effect (llama.cpp only
            # reads LLAMA_CACHE from its own process environment, not from
            # ours parsing it and doing something clever on its behalf).
            env = dict(os.environ)
            env["LLAMA_CACHE"] = LLAMA_CACHE_DIR
            proc = subprocess.Popen(cmd, env=env, stdout=log_f, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            _spawned = (proc, log_f)

        t_wait_start = time.monotonic()
        ok = _wait_until_ready(LLAMA_STARTUP_TIMEOUT)
        wait_elapsed = time.monotonic() - t_wait_start
        if ok:
            # This elapsed time is the actual tell for whether a real
            # download just happened, since the misleading old message here
            # used to just assert "first run downloads it" unconditionally
            # regardless of whether that was true. A cached model loading is
            # normally well under a minute; a real multi-GB download is
            # minutes, not seconds -- if you're seeing this print several
            # minutes on every single restart, the model is genuinely being
            # re-downloaded each time, which means something's still off
            # with the cache dir above (e.g. LLAMA_CACHE_DIR being wiped
            # between runs, or disk permissions preventing the write) --
            # check llama_logs/ and `ls -la` the cache dir printed above.
            print(f"llama-server: ready (took {wait_elapsed:.1f}s -- a cached model loads in well under a "
                  "minute; several minutes here means it just downloaded fresh)")
        else:
            print(f"llama-server: NOT responding after {LLAMA_STARTUP_TIMEOUT:.0f}s -- check llama_logs/, requests will 502 until it comes up")


def stop_llama_server():
    """Stop the llama-server process THIS run of serve.py actually spawned
    (see start_llama_server's own comment) -- registered with atexit() AND
    called explicitly in main()'s finally block, but guarded by _pool_lock +
    clearing `_spawned` after so it's safe to run twice (atexit firing after
    an already-explicit stop is a no-op, not a double-kill)."""
    global _spawned
    with _pool_lock:
        if _spawned is None:
            return
        proc, log_f = _spawned
        if proc.poll() is None:
            print(f"llama-server: stopping (pid {proc.pid})")
            try:
                proc.terminate()
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
            except Exception as e:
                print(f"llama-server: error stopping -- {e}", file=sys.stderr)
        try:
            log_f.close()
        except Exception:
            pass
        _spawned = None


# Real bug report: two /api/llm-families POSTs landing on different
# ThreadingHTTPServer request threads at close to the same moment (much more
# likely now that several parallel LLM checks can all finish around the same
# time) both wrote to the exact same FIXED tmp filename
# (llm_families.json.tmp). Whichever thread's os.replace() ran first
# renamed that path away entirely; the other thread's subsequent
# os.replace() call then found nothing left at that path and raised
# FileNotFoundError, which crashed that request's handler with a raw
# traceback in the terminal (though the OTHER thread's write still
# succeeded, so no actual data loss -- just one of the two writes lost the
# race and errored instead of completing). This lock serializes every
# read/write of llm_families.json across threads in this process, which
# fixes the crash directly (no two threads ever touch the tmp file at the
# same time) and also avoids a related-but-quieter problem: without
# serialization, two racing writes computed from slightly different
# starting snapshots could silently clobber each other's changes even when
# neither one crashes.
_llm_families_lock = threading.Lock()


def read_llm_families():
    with _llm_families_lock:
        if not os.path.exists(LLM_FAMILIES_PATH):
            return {"families": {}}
        try:
            with open(LLM_FAMILIES_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {"families": {}}


def write_llm_families(data):
    with _llm_families_lock:
        tmp = LLM_FAMILIES_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, LLM_FAMILIES_PATH)

        # Companion `<script>`-loadable mirror, same pattern as data.js — kept
        # in lockstep on every write so a plain double-clicked index.html
        # (file://, can't fetch() local JSON) shows the same confirmed
        # generations as the live serve.py session that produced them.
        js_tmp = LLM_FAMILIES_DATA_JS_PATH + ".tmp"
        with open(js_tmp, "w", encoding="utf-8") as f:
            f.write("window.LLM_FAMILIES_STATIC = " + json.dumps(data, ensure_ascii=False) + ";\n")
        os.replace(js_tmp, LLM_FAMILIES_DATA_JS_PATH)


LLM_BACKUP_DIR = os.path.join(DIR, "..", "llm_layer_backups")


def reset_llm_families():
    """Empty the LLM overlay, after copying it somewhere recoverable.

    Returns (counts_cleared, backup_path_or_None). Holds the same lock every
    other write to this file takes, so a decision landing at the same moment
    cannot interleave with the truncate."""
    with _llm_families_lock:
        counts, backup = {}, None
        if os.path.exists(LLM_FAMILIES_PATH):
            try:
                with open(LLM_FAMILIES_PATH, encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    counts = {k: len(v) for k, v in data.items()
                              if isinstance(v, (dict, list)) and len(v)}
            except Exception:
                counts = {}   # unreadable is still resettable; it just cannot be summarised
            os.makedirs(LLM_BACKUP_DIR, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup = os.path.join(LLM_BACKUP_DIR, f"llm_families-{stamp}.json")
            shutil.copy2(LLM_FAMILIES_PATH, backup)
        tmp = LLM_FAMILIES_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("{}\n")
        os.replace(tmp, LLM_FAMILIES_PATH)
        js_tmp = LLM_FAMILIES_DATA_JS_PATH + ".tmp"
        with open(js_tmp, "w", encoding="utf-8") as f:
            f.write("window.LLM_FAMILIES_STATIC = {};\n")
        os.replace(js_tmp, LLM_FAMILIES_DATA_JS_PATH)
        return counts, backup


# Same race-guard reasoning as _llm_families_lock just above, for the
# separate db_match_overrides.json file app/db_match.html reads/writes.
_db_match_overrides_lock = threading.Lock()


def read_db_match_overrides():
    with _db_match_overrides_lock:
        if not os.path.exists(DB_MATCH_OVERRIDES_PATH):
            return {"overrides": {}}
        try:
            with open(DB_MATCH_OVERRIDES_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) and "overrides" in data else {"overrides": {}}
        except (json.JSONDecodeError, OSError):
            return {"overrides": {}}


def write_db_match_overrides(data):
    with _db_match_overrides_lock:
        tmp = DB_MATCH_OVERRIDES_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, DB_MATCH_OVERRIDES_PATH)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        # SimpleHTTPRequestHandler sends Last-Modified and no Cache-Control at
        # all, which lets a browser cache app.js, styles.css and data.js
        # heuristically -- for however long it feels like. Real user report:
        # "for some reason the serve.py webview doesn't display anything, but
        # only the actual online web-hosted page does." The hosted build is
        # served by a Worker that sets its own headers; this one was handing
        # back yesterday's files, so a fix could be live on the public site
        # and invisible on the machine it was written on. This is a local
        # development server -- it should never be the stale one.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def _json(self, status, payload):
        # Real bug report: a slow/failed llama-server call (this is most
        # often hit by the /api/llm/chat 502 path below) can take long
        # enough that the BROWSER has already given up and closed its end of
        # the connection by the time this finally has something to send back
        # -- totally normal (navigated away, closed the detail panel, page
        # reloaded), not a bug in this server. Before this, that raced
        # straight into send_response()/end_headers()'s own socket write,
        # which raised a raw BrokenPipeError/ConnectionResetError that
        # propagated all the way up through socketserver's request-handling
        # machinery as an unhandled exception -- a scary multi-frame
        # traceback dumped to the terminal for what is, from this server's
        # point of view, a completely unremarkable "nobody's listening
        # anymore" event. Nothing useful to do at that point except stop
        # trying to write to a socket that's already gone.
        try:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError) as e:
            self.log_message("client disconnected before response could be sent (%s)", e)

    def do_GET(self):
        if self.path == "/api/llm-families":
            # Server-side settings ride along on the same request that seeds
            # the store, so the browser has them before app.js builds its
            # indexes -- no second round trip, and serve.py stays the ONE
            # place these are configured. Namespaced under "__config" for the
            # same reason "__serverAvailable" is underscored: llm_families.js
            # builds its persisted store from explicit keys, so nothing here
            # can leak back into llm_families.json on the next write.
            payload = read_llm_families()
            payload["__config"] = {"cascadeMaxDepth": CASCADE_MAX_DEPTH,
                                   "transitiveMaxHops": TRANSITIVE_MAX_HOPS}
            return self._json(200, payload)
        if self.path == "/api/db-match-overrides":
            return self._json(200, read_db_match_overrides())
        if self.path == "/api/rebuild":
            return self._json(200, _rebuild_status())
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/rebuild":
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                body = {}
            if not os.path.exists(REBUILD_SCRIPT):
                return self._json(500, {"error": "data_src/rebuild.sh not found at %s" % REBUILD_SCRIPT})
            with _rebuild_lock:
                if _rebuild["running"]:
                    # Two rebuilds writing app/data.js at once would interleave
                    # their output into the same file. One at a time.
                    return self._json(409, {"error": "a rebuild is already running",
                                            "step": _rebuild["step"]})
                _rebuild.update({"running": True, "step": "starting", "log": [], "ok": None,
                                 "started": time.time(), "finished": None, "returncode": None})
            skip = bool(body.get("skipHarvest"))
            threading.Thread(target=_rebuild_worker, args=(skip,), daemon=True).start()
            print("rebuild: started%s" % (" (--no-harvest)" if skip else ""), flush=True)
            return self._json(200, {"ok": True, "started": True, "skipHarvest": skip})

        if self.path == "/api/llm-families":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid JSON body"})
            if not isinstance(data, dict) or "families" not in data:
                return self._json(400, {"error": "expected {\"families\": {...}}"})
            write_llm_families(data)
            return self._json(200, {"ok": True})

        if self.path == "/api/db-match-overrides":
            # app/db_match.html (the manual My Database review page) POSTs
            # the FULL overrides object here every time (read-modify-write on
            # the client side, same contract /api/llm-families above already
            # uses) -- see data_src/build_db_layer.py's module docstring for
            # what these overrides actually mean. refresh_db_layer() re-runs
            # SYNCHRONOUSLY, right here in the request, rather than just
            # writing the file and waiting for the next serve.py restart --
            # a person clicking "Match" in the review page wants to see
            # cars.json/data.js (and this file's own db_match_report.json,
            # which the review page immediately re-fetches) reflect that
            # decision right away, not after manually restarting the server.
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid JSON body"})
            if not isinstance(data, dict) or "overrides" not in data or not isinstance(data["overrides"], dict):
                return self._json(400, {"error": "expected {\"overrides\": {...}}"})
            write_db_match_overrides(data)
            try:
                refresh_db_layer()
            except Exception as e:
                # The override itself is already safely written to disk at
                # this point -- a failure re-running the enrichment (a
                # malformed specs.md elsewhere, a transient file error)
                # shouldn't make it look like the override save itself
                # failed. refresh_db_layer() already logs+swallows its own
                # per-folder errors; this is only for something unexpected
                # escaping that.
                print(f"db-match-overrides: saved, but refresh_db_layer() raised -- {e}", file=sys.stderr)
            return self._json(200, {"ok": True})

        # Real user confusion, worth fixing rather than explaining: this
        # terminal only ever showed llama.cpp calls, because those are the
        # only thing that comes through this proxy. Everything else the app
        # does -- reading a Wikipedia article, scanning a generation's
        # infobox for engines, applying a split -- happens browser-to-
        # Wikipedia and left no trace here at all, so a long model call
        # looked like the only thing happening while several other passes
        # ran invisibly alongside it. This endpoint is how the page says
        # what it is doing; it stores nothing and answers immediately.
        # Real user request: "add two buttons, one that wipes all the LLM stuff
        # (links, nodes, etc everything done by the llm), and a third button
        # which wipes everything and starts from scratch (no LLM stuff done,
        # and the full graph rebuilt from dbpedia)."
        #
        # Server-side rather than "have the page POST an empty store": the
        # overlay is the only half of this project that cannot be rebuilt from
        # public sources -- it is hours of local model time plus every
        # accept/reject decision -- so it is copied somewhere recoverable
        # first, always, by the same code that empties it. Same thing
        # scripts/reset_llm_layer.sh does from a terminal.
        if self.path == "/api/llm-reset":
            try:
                counts, backup = reset_llm_families()
            except Exception as e:
                return self._json(500, {"error": "could not reset the LLM layer", "detail": str(e)})
            print(f"llm layer: reset ({sum(counts.values())} record(s) cleared); "
                  f"backup: {backup or 'nothing to back up'}", flush=True)
            return self._json(200, {"ok": True, "cleared": counts, "backup": backup})

        if self.path == "/api/note":
            length = int(self.headers.get("Content-Length", 0))
            try:
                note = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid JSON body"})
            text = " ".join(str(note.get("text", "")).split())[:200]
            if text:
                _print_live("[app] " + text)
            return self._json(200, {"ok": True})

        if self.path == "/api/llm/chat":
            length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(length)
            # Stamp the model here, server-side, so LLAMA_MODEL/LLAMA_MODEL_ALIAS
            # (above) are the ONLY place that needs editing to change models --
            # the browser's own request (see llm_families.js's askLlamaCpp) no
            # longer sends a "model" field at all, and even if some other
            # caller did, this always overwrites it. Also forces "stream":
            # true regardless of what the client asked for -- this proxy
            # needs to read the response as it's generated (not all at once)
            # both to print live tokens/sec to this terminal AND because a
            # per-chunk read timeout behaves better than one giant read for a
            # response that can take minutes (see LLAMA_TIMEOUT's own
            # comment). Reasoning is suppressed via the server-startup
            # --reasoning off / --reasoning-budget 0 flags (see
            # start_llama_server's own comment) rather than a per-request
            # field here -- this used to also stamp a per-request
            # "chat_template_kwargs": {"enable_thinking": false} as a second
            # layer, but that's the same mechanism newer llama-server builds
            # print a deprecation warning for at startup, and stamping it on
            # EVERY request here would print that warning on every single
            # LLM call instead of once. Everything else in the body
            # (messages, response_format, ...) passes through untouched.
            try:
                chat_req = json.loads(raw_body or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid JSON body"})
            if not isinstance(chat_req, dict):
                return self._json(400, {"error": "expected a JSON object body"})
            chat_req["model"] = LLAMA_MODEL_ALIAS
            chat_req["stream"] = True
            # See LLAMA_MAX_TOKENS: without a ceiling, a model that stops
            # answering and starts looping generates until someone notices.
            if not chat_req.get("max_tokens"):
                chat_req["max_tokens"] = LLAMA_MAX_TOKENS
            # Real user request: "for the terminal, I want it to be a bit more
            # descriptive than just counting the tokens used and the number of
            # tokens per second. I want a short brief description of what
            # relationship each of the LLM's is currently checking alongside
            # the count and rate. It should also explain whether it is doing a
            # designer, engineer, successor, etc check."
            #
            # With LLAMA_PARALLEL slots all busy, several checks interleave
            # their progress lines in this terminal at once, and "[req-7] 214
            # tok in 4.1s" gives no way to tell which car -- let alone which
            # KIND of check -- any given line belongs to. Every call site in
            # llm_families.js now sends a short "purpose" label describing
            # exactly what it's asking about (generation split + designers/
            # engineers, a specific relation between two named nameplates, a
            # duplicate sanity check, a production-year or biography lookup).
            # Popped rather than forwarded: it isn't part of llama-server's
            # OpenAI chat-completions schema, and passing an unknown field
            # through risks a 400 on stricter builds.
            purpose = chat_req.pop("purpose", None)
            if not isinstance(purpose, str) or not purpose.strip():
                purpose = "LLM request"
            purpose = " ".join(purpose.split())
            # The live/summary lines below are rewritten in place on one
            # terminal row (see _print_live), so a long purpose would push the
            # token count and rate off the edge -- keep a short form for those
            # and print the full text once, up front, on its own line.
            # Real user request: "I want that the description of what it is
            # doing (for example 'generation split + designers/engineers/
            # related cars') to be shortened so that I can better see what
            # models and makes of cars are occurring." Every call site now
            # leads with the CAR and trails a short kind-of-check tag (see
            # llm_families.js's askLlamaCpp calls), and this cap is generous
            # enough that a real car name is never the thing that gets cut.
            short_purpose = purpose if len(purpose) <= 58 else purpose[:55] + "..."
            # Defensive strip, not just a client-side omission: any caller
            # (a stale browser cache, someone pasting a raw request body
            # into the playground's "Run it here", a future call site) that
            # still sends the old per-request "chat_template_kwargs" field
            # would otherwise print llama-server's deprecation warning on
            # every single request it reaches -- see the comment above.
            chat_req.pop("chat_template_kwargs", None)
            body = json.dumps(chat_req).encode("utf-8")

            req = urllib.request.Request(
                LLAMA_BASE_URL + "/v1/chat/completions",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            req_id = _next_request_id()
            # Printed once, in full, before any progress line -- so the
            # complete description is always in the scrollback even though
            # the progress line itself only has room for the short form.
            print(f"[{req_id}] {LLAMA_MODEL_ALIAS}: starting -- {purpose}", flush=True)
            t0 = time.monotonic()
            content_parts = []
            n_chunks = 0
            final_timings = None
            finish_reason = None
            last_print_t = t0
            LIVE_PRINT_INTERVAL = 0.5  # seconds -- avoid spamming the terminal on a fast model

            try:
                # Real bug report (carried over from the Ollama era, worse
                # now that a slow first-run model download can also delay
                # things): a naive single r.read() call for the WHOLE
                # response either times out mid-generation on a long answer,
                # or (the Ollama-era bug) raises a bare TimeoutError that
                # wasn't caught, hanging the browser forever. Reading one
                # streamed SSE line at a time means LLAMA_TIMEOUT is really
                # "seconds allowed between tokens", which is both a more
                # forgiving and more accurate timeout for a model that can
                # legitimately take minutes overall but should never go
                # quiet for that long between individual tokens.
                with urllib.request.urlopen(req, timeout=LLAMA_TIMEOUT) as r:
                    for raw_line in r:
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if not line or not line.startswith("data:"):
                            continue
                        payload_str = line[len("data:"):].strip()
                        if payload_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload_str)
                        except json.JSONDecodeError:
                            continue  # a malformed/partial SSE line shouldn't crash the whole request
                        choices = chunk.get("choices") or []
                        if choices:
                            delta = choices[0].get("delta") or {}
                            piece = delta.get("content") or ""
                            if piece:
                                content_parts.append(piece)
                                n_chunks += 1
                            if choices[0].get("finish_reason"):
                                finish_reason = choices[0]["finish_reason"]
                        # llama.cpp puts the full timing breakdown on the
                        # LAST chunk only (confirmed against llama.cpp's own
                        # maintainers: intermediate chunks carry just the
                        # text delta) -- grab it whenever it shows up rather
                        # than assuming which chunk it'll be on.
                        if chunk.get("timings"):
                            final_timings = chunk["timings"]

                        now = time.monotonic()
                        if now - last_print_t >= LIVE_PRINT_INTERVAL and n_chunks > 0:
                            elapsed = now - t0
                            live_tps = n_chunks / elapsed if elapsed > 0 else 0.0
                            # Same line, but it stops reading like healthy
                            # progress once the count is well past anything
                            # this app ever legitimately asks for.
                            tail = (f" -- OVERLONG, will be cut off at {chat_req['max_tokens']}"
                                    if n_chunks > LLAMA_RUNAWAY_TOKENS else "...")
                            _print_live(f"[{req_id}] {short_purpose} -- {n_chunks} tok in {elapsed:.1f}s ({live_tps:.1f} tok/s so far){tail}")
                            last_print_t = now
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                self._json(502, {
                    "error": "could not reach llama-server at " + LLAMA_BASE_URL,
                    "detail": str(e),
                    "hint": "Is `llama-server` running (see README.md)? Is the model "
                            f"'{LLAMA_MODEL}' fully downloaded? If this was a timeout between "
                            f"tokens, current limit is {LLAMA_TIMEOUT}s (set LLAMA_TIMEOUT to raise it).",
                })
                return

            elapsed = time.monotonic() - t0
            # Prefer llama.cpp's own reported predicted_per_second (measures
            # actual generation time only) over our own wall-clock elapsed
            # (which also includes prompt processing + network overhead) --
            # fall back to the wall-clock figure if the final chunk's
            # timings never showed up for some reason, so this line always
            # prints something rather than silently skipping the summary.
            # A call the ceiling had to cut short did not answer the
            # question -- the client will see truncated JSON and record an
            # error. Said plainly here, because the alternative is a summary
            # line that looks exactly like a successful one.
            cut_off = finish_reason == "length"
            if cut_off:
                live_tps = n_chunks / elapsed if elapsed > 0 else 0.0
                _print_live(f"[{req_id}] {short_purpose} -- CUT OFF at the {chat_req['max_tokens']}-token "
                            f"ceiling after {elapsed:.1f}s ({live_tps:.1f} tok/s); the model was looping, "
                            "not answering. Nothing was learned from this call.")
            elif final_timings and "predicted_per_second" in final_timings:
                final_tps = final_timings["predicted_per_second"]
                final_n = final_timings.get("predicted_n", n_chunks)
                _print_live(f"[{req_id}] {short_purpose} -- done, {final_n} tok in {elapsed:.1f}s wall ({final_tps:.1f} tok/s generation)")
            else:
                live_tps = n_chunks / elapsed if elapsed > 0 else 0.0
                _print_live(f"[{req_id}] {short_purpose} -- done, {n_chunks} tok in {elapsed:.1f}s ({live_tps:.1f} tok/s, estimated -- server didn't report timings)")

            # The browser only ever sees ONE complete response, same as
            # before -- everything above happened purely so this terminal
            # could show live progress; nothing about the client-facing
            # contract changed. Shaped close to a normal (non-streaming)
            # OpenAI chat-completion response so llm_families.js's parsing
            # stays simple (choices[0].message.content), plus the raw
            # timings for anyone who wants them (not currently read by the
            # client, but harmless to include).
            # finish_reason travels with the answer. Real incident, the
            # Mercedes-Benz W108/W109: the reply was cut at the ceiling, the
            # browser got JSON with no closing brace, and the only thing it
            # could say was "returned something that isn't JSON" -- which
            # reads like a broken model rather than a call that ran out of
            # room. This terminal already knew (see the CUT OFF line above);
            # the page had no way to.
            response_payload = {
                "model": LLAMA_MODEL_ALIAS,
                "choices": [{"message": {"role": "assistant", "content": "".join(content_parts)},
                             "finish_reason": finish_reason or None}],
                "timings": final_timings,
                "maxTokens": chat_req.get("max_tokens"),
            }
            self._json(200, response_payload)
            return

        self._json(404, {"error": "no such endpoint"})


CARS_JSON_PATH = os.path.join(DIR, "cars.json")
DATA_JS_PATH = os.path.join(DIR, "data.js")


def refresh_db_layer():
    """Re-run My Database enrichment against the CURRENT "Car Database"
    folder and rewrite cars.json/data.js if anything changed -- see point 4
    of the module docstring. Mirrors build_db_layer.py's own standalone
    runner (and the identical enrich()+flag_garage() call build_data.py's
    full pipeline makes) so a server restart alone is enough to pick up a
    newly-added car folder, no manual `python3 build_db_layer.py` required.
    Best-effort: any failure is printed and swallowed so a malformed
    specs.md or a missing Car Database folder never blocks the app itself
    from starting (enrich() already tolerates a missing folder gracefully;
    this try/except is for anything else -- bad JSON, a parsing exception,
    etc.).
    """
    # Off by default, matching build_data.py's CARWEB_DB_LAYER. The layer
    # reads a private "Car Database" tree that is not part of this repository,
    # so a public checkout must never enrich from it.
    if os.environ.get("CARWEB_DB_LAYER", "0").strip().lower() not in ("1", "true", "yes", "on"):
        print("db layer: disabled (set CARWEB_DB_LAYER=1 to enable)")
        return
    if not os.path.exists(CARS_JSON_PATH):
        return  # nothing to enrich onto yet -- run the full build pipeline first
    try:
        sys.path.insert(0, os.path.join(DIR, "..", "data_src"))
        # Resolved at runtime off the sys.path line above, and only ever
        # reached when CARWEB_DB_LAYER is on (checked at the top of this
        # function). build_db_layer.py is intentionally absent from the public
        # checkout, so a static analyser cannot resolve this and reports it as
        # a missing import -- expected, hence the ignore. The enclosing
        # try/except is what handles it at runtime.
        from build_db_layer import enrich as enrich_db_layer, flag_garage  # type: ignore[import-not-found]

        with open(CARS_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        before = json.dumps(data, sort_keys=True)

        stats = enrich_db_layer(data["nodes"])
        # Same hardcoded call build_data.py's full pipeline and
        # build_db_layer.py's own standalone runner both already make --
        # Andy's own garage car, not a generic "detect the newest car" guess.
        flag_garage(data["nodes"], "BMW", "X1", year_hint=2024)

        after = json.dumps(data, sort_keys=True)
        if after == before:
            print(f"My Database: no changes (matched={stats['matched']} ambiguous={stats['ambiguous']} unmatched={stats['unmatched']})")
            return

        with open(CARS_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        with open(DATA_JS_PATH, "w", encoding="utf-8") as f:
            f.write("window.CARDATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
        print(f"My Database: updated cars.json/data.js (matched={stats['matched']} ambiguous={stats['ambiguous']} unmatched={stats['unmatched']})")
    except Exception as e:
        print(f"My Database: skipped refresh, error during enrichment -- {e}", file=sys.stderr)


def _handle_sigterm(signum, frame):
    # KeyboardInterrupt (below) only ever catches Ctrl+C (SIGINT). A plain
    # `kill <pid>` sends SIGTERM instead, which Python doesn't turn into an
    # exception by default -- without this handler, a SIGTERM would kill
    # serve.py immediately without ever reaching stop_llama_server(), leaving
    # the llama-server process it spawned orphaned and running. Raising
    # SystemExit here routes it through the exact same try/finally path as
    # Ctrl+C does.
    raise SystemExit(0)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8077
    if not os.path.exists(LLM_FAMILIES_PATH):
        write_llm_families({"families": {}})
    else:
        # Regenerate the companion .js mirror unconditionally at startup too —
        # covers upgrading onto this feature with an existing llm_families.json
        # that predates it, or the .js file having been deleted/edited by hand.
        write_llm_families(read_llm_families())
    # Refreshing the My Database layer at startup re-fetches car photos and
    # rewrites app/db_photos/ and the match report with absolute paths from
    # whatever machine is running. That's correct on a real machine and wrong
    # anywhere else -- a test or a sandbox that starts this server to poke one
    # endpoint would silently rewrite a working copy's photos with whatever
    # its own network hands back. CARWEB_SKIP_DB_REFRESH=1 skips it.
    if os.environ.get("CARWEB_SKIP_DB_REFRESH", "").strip().lower() in ("1", "true", "yes", "on"):
        print("db layer: refresh skipped (CARWEB_SKIP_DB_REFRESH set)")
    else:
        refresh_db_layer()

    # Registered before start_llama_server() runs, not after -- if something
    # inside startup itself raises, we still want a clean shutdown of
    # whatever it already managed to spawn rather than leaking the process.
    atexit.register(stop_llama_server)
    signal.signal(signal.SIGTERM, _handle_sigterm)

    # Blocks (see _wait_until_ready's own comment) until llama-server is
    # actually ready to answer requests -- runs BEFORE ThreadingHTTPServer
    # starts listening, precisely so no browser request can ever reach
    # /api/llm/chat before the model has finished loading (or downloading,
    # on a first run).
    start_llama_server()

    try:
        with http.server.ThreadingHTTPServer(("localhost", port), Handler) as httpd:
            print(f"The Car Web — serving {DIR} at http://localhost:{port}/index.html")
            print(f"llama-server target: {LLAMA_BASE_URL}  (model: {LLAMA_MODEL_ALIAS}, "
                  f"{LLAMA_PARALLEL_EFFECTIVE} concurrent slot(s), "
                  f"MTP {'on' if LLAMA_MTP else 'off'})")
            print(f"llm_families.json:   {LLM_FAMILIES_PATH}")
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\nstopped.")
    finally:
        # Explicit call, not just relying on atexit -- guarantees
        # llama-server is torn down before main() returns even in edge cases
        # where atexit handlers might not run (e.g. os._exit elsewhere).
        # Safe to run twice: stop_llama_server() clears `_spawned` after
        # stopping, so atexit firing again afterward is a no-op.
        stop_llama_server()


if __name__ == "__main__":
    main()
