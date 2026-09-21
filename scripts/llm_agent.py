#!/usr/bin/env python3
"""The Car Web — request-queue agent.

Picks up a scan job left by the hosted site's "⚡ Request scan" button, runs
the local LLM generation pass, pushes the result, and exits.

The AGENT_TOKEN secret is read from ~/.carweb-agent-token, or from
CARWEB_AGENT_TOKEN if that is set. The file is the easier one: an export lasts
one shell, and a scheduled run has no shell to have exported it in.

    printf %s 'THE_TOKEN' > ~/.carweb-agent-token && chmod 600 ~/.carweb-agent-token
    python3 scripts/llm_agent.py           # wait up to 10 min for a job, run it
    python3 scripts/llm_agent.py --watch   # keep waiting (for launchd/cron)
    python3 scripts/llm_agent.py --now     # scan from the backlog, no job needed
    python3 scripts/llm_agent.py --queue   # what has been requested
    python3 scripts/llm_agent.py --drop m-buick-century
    python3 scripts/llm_agent.py --clear   # empty it

A QUEUED REQUEST NAMES ONE CAR -- someone focused it in the graph and asked
for it -- and that car is the seed. --now has no request to read, so it takes
the top of the review backlog instead.

HOW MUCH ONE RUN SCANS is governed by the CASCADE, not by a count in here.
One seed car pulls in whatever its own article names, out to serve.py's
CASCADE_MAX_DEPTH -- the same budget a click gets, so the agent spends the
model the way a person does. --seeds is only how many places it starts from,
and defaults to 1. --cascade-depth overrides the server's setting for one run.

Why a queue and not a listener: the Mac has no public address and is usually
asleep, so nothing on the internet can call it. See docs/REQUEST-QUEUE.md.

WHAT IT CONFIRMS. It drives the real UI, so it inherits the app's own rule
exactly -- which is NOT "nothing is ever confirmed":

  * A plain model that turns out to hide several generations is split and
    applied immediately. That is a deliberate existing decision ("if a car is
    creating a nameplate for the first time... you do not need my approval to
    turn it into a nameplate"), and it is most of the review queue.
  * A correction to a nameplate that ALREADY has a generation list stays
    provisional and waits for a human, because it rewrites data someone may
    be relying on.

Nothing here widens that. Every claim still has to appear verbatim in the
article before it is kept -- the guard in llm_families.js runs on this path
because this path IS the app.

Stdlib + playwright only. serve.py starts and stops llama-server itself, so
stopping serve.py is what "closes the program running locally".
"""
import argparse
import datetime as dt
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
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
REPORT = os.path.join(ROOT, "data_src", "harvest", "family_match_report.txt")
LLM_FAMILIES = os.path.join(APP, "llm_families.json")

QUEUE = os.environ.get("CARWEB_QUEUE_URL", "https://carweb.quirksandfeats.workers.dev")
PORT = int(os.environ.get("CARWEB_PORT", "8077"))
# Read the same way serve.py reads it (loopback only, same default), so "is
# the model still up?" is asked of the right address rather than guessed. Only
# ever used to LOOK -- nothing here starts or stops llama-server, serve.py
# owns that.
LLAMA_PORT = int(os.environ.get("LLAMA_PORT", "8080"))

# The token, from the environment or from a file. An `export` lasts one shell,
# so every new terminal met "set CARWEB_AGENT_TOKEN" again -- and a scheduled
# run has no shell to have exported it in at all. The file lives in the HOME
# directory, not the repo: this repo is public, and a secret one `git add -A`
# away from being published is a secret waiting to leak.
TOKEN_FILE = os.path.expanduser("~/.carweb-agent-token")


def read_token():
    tok = os.environ.get("CARWEB_AGENT_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


TOKEN = read_token()

# Files the pass can touch. llm_families_data.js is the <script>-loadable
# mirror serve.py regenerates on every write, so it moves with the JSON and
# has to be committed alongside it or a plain file:// open goes stale.
TRACKED = ["app/llm_families.json", "app/llm_families_data.js"]


def name_list(label, ids, limit=5):
    if not ids:
        return ""
    shown = ", ".join(ids[:limit])
    more = f" +{len(ids) - limit} more" if len(ids) > limit else ""
    return f"; {label}: {shown}{more}"


def commit_body(split, waiting, nothing, skipped, errors):
    lines = []
    for label, ids in (("Split and applied without review (seeds and cascade alike)", split),
                       ("Awaiting your review", waiting),
                       ("Nothing found", nothing),
                       ("Skipped (budget, or no longer in the graph)", skipped)):
        if ids:
            lines.append(label + ":")
            lines += ["  " + i for i in ids]
            lines.append("")
    if errors:
        lines.append("Errors:")
        lines += ["  " + e for e in errors[:20]]
        lines.append("")
    if split:
        lines.append("Everything under the first heading carries "
                     'decidedBy:"agent" in llm_families.json.')
    return "\n".join(lines).strip()


NO_TOKEN = (
    "No agent token. Either put it in a file, once:\n"
    f"    printf %s 'YOUR_AGENT_TOKEN' > {TOKEN_FILE} && chmod 600 {TOKEN_FILE}\n"
    "or export it for this shell:\n"
    "    export CARWEB_AGENT_TOKEN='YOUR_AGENT_TOKEN'"
)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------- stopping ----
# Real user request: "aborting the agent with ctrl + c should gracefully close,
# not show a keyboard interrupt message. I want to make sure that everything
# closes gracefully and correctly."
#
# Ctrl+C used to surface as a KeyboardInterrupt traceback out of whatever
# blocking call happened to be running, which is ugly and, worse, is not the
# whole story: this run owns a headless browser, a serve.py that owns
# llama-server (a multi-GB model resident in memory), and a job the queue has
# marked "running". Left behind, the model stays loaded and the job stays
# claimed, so the next run refuses to start on a port that is still in use and
# the site keeps showing a scan that never finishes.
#
# So an interrupt is turned into an ordinary exception instead. It unwinds
# through the same `finally` blocks a normal finish uses -- close the browser,
# SIGTERM serve.py, push whatever was already written, tell the queue -- and
# the process exits 130 with one line of explanation and no traceback.
#
# Pressing it again while that is happening is a real thing people do, so it
# is answered rather than ignored: the second press says what is still going
# on, and the third gives up on the cleanup and exits immediately.
class Aborted(Exception):
    """Ctrl+C (or SIGTERM), raised where it can be caught and cleaned up after."""


STOPPING = False      # an interrupt has been seen
CLEANING = False      # ...and we are now in the shutdown path, where raising again would strand things
_extra_interrupts = 0


def _on_signal(signum, frame):
    global STOPPING, _extra_interrupts
    name = "SIGTERM" if signum == signal.SIGTERM else "Ctrl+C"
    if CLEANING or STOPPING:
        _extra_interrupts += 1
        if _extra_interrupts >= 2:
            log("giving up on a clean shutdown -- exiting now (llama-server may "
                "still be running; check with: lsof -i :%d)" % PORT)
            os._exit(130)
        log("still closing down -- press Ctrl+C again to force it")
        return
    STOPPING = True
    # Deliberately not a list of what is being shut down: at this point that
    # depends entirely on how far the run had got, and naming a browser and a
    # model that were never started reads as a lie. The things that do get
    # closed announce themselves as they go (stop_serve says so by name).
    log(f"{name} -- stopping, keeping whatever has already been found")
    raise Aborted()


def install_signal_handlers():
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)


def begin_cleanup():
    """Once an interrupt has been seen, a LATER one must not unwind anything --
    it would abandon the shutdown half done, which is the exact mess this is
    for. A normal finish is left interruptible, so a slow stop_serve can still
    be cut short the graceful way."""
    global CLEANING
    if STOPPING:
        CLEANING = True


# ---------------------------------------------------------------- the queue --
def api(path, method="GET", body=None, timeout=30):
    req = urllib.request.Request(
        QUEUE.rstrip("/") + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
            "User-Agent": "carweb-llm-agent/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        # The queue being unreachable is not a failure worth reporting to the
        # queue (which is unreachable). Treat it as "no job" and try later.
        log(f"queue unreachable: {e}")
        return 0, {}


def _claim_age(job):
    """Seconds since the job was claimed, or None if it does not say."""
    stamp = (job or {}).get("claimedAt")
    if not stamp:
        return None
    try:
        t = dt.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return max(0, int((dt.datetime.now(dt.timezone.utc) - t).total_seconds()))


def wait_for_job(poll_seconds, give_up_after):
    """Returns a job dict, or None once give_up_after seconds have passed.
    give_up_after of 0 means wait forever."""
    started = time.time()
    while True:
        status, d = api("/api/request/jobs")
        if status == 401:
            sys.exit("the queue rejected CARWEB_AGENT_TOKEN -- check the secret")
        if status == 503:
            sys.exit("the queue is not configured yet -- see docs/REQUEST-QUEUE.md")
        job = d.get("job") if status == 200 else None
        if job and job.get("state") != "running":
            return job
        if job:
            # Someone (probably an earlier run of this script that died) has
            # it claimed. Don't stampede it -- but say how long it has been
            # like that and how to take it back, because a claim left by a
            # dead run otherwise looks like the queue silently doing nothing.
            held = _claim_age(job)
            since = f" for {held // 60} min" if held is not None else ""
            log(f"job {job['id'][:8]} ({job.get('targetLabel') or job.get('targetId')}) "
                f"is already marked running{since}; leaving it alone")
            log(f"  if that run is dead: llm_agent.py --release {job['id'][:8]} "
                f"to requeue it, or --drop {job['id'][:8]} to remove it")
        if give_up_after and time.time() - started >= give_up_after:
            return None
        time.sleep(poll_seconds)


# -------------------------------------------------------------- the targets --
def review_queue_ids(path=None):
    """Node ids from the family report's two review sections -- the "review
    backlog", which is a different thing from the job QUEUE in Cloudflare.
    The queue holds requests to run; the backlog is the list of cars a run
    works through.

    UN-SPLIT NAMEPLATE CANDIDATES comes FIRST, and the order is the point.
    Those are the models where a credited designer's dates contradict the
    article's own date range -- Wayne Cherry cannot have designed the 1933
    Suburban -- so there is positive evidence that the article covers several
    generations. UNCONFIRMED is the weaker signal: a candidate group was found
    and could not be joined into a chain, which is often because the
    candidates genuinely are separate cars. A run with a budget should spend
    it on the evidence, not on the maybes.

    Deliberately NOT every eligible model in the graph: that is thousands of
    nodes, nearly all of them single-generation cars with nothing to find.
    """
    text_path = path or REPORT
    if not os.path.exists(text_path):
        return []
    text = open(text_path, encoding="utf-8").read()
    out, seen = [], set()
    for header in ("UN-SPLIT NAMEPLATE CANDIDATES (", "UNCONFIRMED ("):
        start = text.find(header)
        if start < 0:
            continue
        # Up to the next section heading, which is the only other place a
        # line starts with a capitalised all-caps word at column zero.
        rest = text[start + len(header):]
        m = re.search(r"\n(?=[A-Z][A-Z \-]{6,}\()", rest)
        block = rest[: m.start()] if m else rest
        for nid in re.findall(r"\bid=(\S+)", block):
            if nid not in seen:
                seen.add(nid)
                out.append(nid)
    return out


def saved_cascade_count(path=None):
    """How many cars an earlier cascade queued and never checked -- the
    page's pendingCascade, read straight off disk so it can be reported
    before anything starts."""
    try:
        d = json.load(open(path or LLM_FAMILIES, encoding="utf-8"))
    except Exception:
        return 0
    return len(d.get("pendingCascade") or {})


def already_scanned(path=None):
    try:
        d = json.load(open(path or LLM_FAMILIES, encoding="utf-8"))
    except Exception:
        return set()
    ids = set(d.get("families", {}))
    ids |= set(d.get("recheck", {}))
    # A node the user dismissed is a deliberate "don't ask me about this
    # again", and re-scanning it would undo that by hand every run.
    ids |= set(d.get("dismissed", {}) if isinstance(d.get("dismissed"), dict) else d.get("dismissed", []))
    return ids


# --------------------------------------------------------------- serve.py ----
def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


# Everything serve.py prints, echoed into this terminal as it arrives.
#
# It used to be swallowed whole: stdout was a PIPE nobody read unless serve.py
# died during startup. That hid the two lines that matter most at the end of a
# run -- "llama-server: already up ... (not ours, won't be stopped on exit)"
# and "llama-server: stopping (pid N)" -- so whether the model was actually
# going to be shut down was invisible, and so was every other thing serve.py
# had to say while a scan was running.
#
# A daemon thread, so it can never hold the process open at exit, and its
# output is prefixed to keep it distinguishable from this script's own log.
# serve.py narrates every HTTP request and every token the model produces.
# That is the right amount of detail when you are debugging serve.py and far
# too much when you are watching a scan: a single car buried some forty lines
# of "[req-1] Mazda 6 . split -- 246 tok in 46.6s" under itself, and the
# agent's own per-car lines were lost in it.
#
# Real user report: "I liked it how it was before, where it was telling me the
# higher level information regarding which car was being checked, current
# operations, etc... without showing an active ping of tokens per second and
# other messages that are not necessary specifically for the agent but are only
# necessary for serve.py (for debugging essentially)."
#
# So this is a DROP list rather than a keep list, on purpose. Everything known
# to be routine narration is filtered; anything else -- a traceback, a warning,
# a line no one has seen before -- still comes through, because the failure
# mode of a keep list is silence about the one thing that mattered. The full
# stream, filtered or not, still goes into `tail`, which is what start_serve
# prints if serve.py never comes up. --verbose relays the lot.
# The one [req-N] line that is never noise: a call the token ceiling had to
# cut short did not answer its question, and the client can only say so in a
# one-line error. Real case, the Mercedes-Benz W108/W109 -- "check failed"
# in the log, with the explanation filtered out of the same terminal.
SERVE_KEEP = [re.compile(r"^\[req-\d+\].*CUT OFF")]
SERVE_NOISE = [
    re.compile(r'^\d+\.\d+\.\d+\.\d+ - "'),      # HTTP access log
    re.compile(r"^\[req-\d+\]"),                    # per-request token progress
    re.compile(r"^llama-server: (starting|model=|MTP |model cache|up,|ready|stopping)"),
    re.compile(r"^db layer:"),
    re.compile(r"^llama-server target:"),
    re.compile(r"^llm_families\.json:"),
    re.compile(r"^The Car Web \S* ?serving"),
]


def _is_serve_noise(line):
    if any(rx.search(line) for rx in SERVE_KEEP):
        return False
    return any(rx.search(line) for rx in SERVE_NOISE)


def _relay_output(proc, tail, verbose=False):
    def pump():
        try:
            for line in proc.stdout:
                line = line.rstrip()
                if not line:
                    continue
                tail.append(line)
                del tail[:-40]
                if verbose or not _is_serve_noise(line):
                    print(f"           serve.py | {line}", flush=True)
        except Exception:
            pass
    t = threading.Thread(target=pump, daemon=True)
    t.start()
    return t


def start_serve(cascade_depth=None, verbose=False):
    if port_open(PORT):
        sys.exit(f"something is already listening on :{PORT} -- stop it first, "
                 "so this script doesn't drive a server it cannot shut down")
    log("starting serve.py (it starts llama-server itself, and the model load "
        "can take a minute)")
    env = dict(os.environ)
    if cascade_depth is not None:
        # serve.py owns this number and sends it down to the page on the same
        # GET that seeds the store, so setting it here is the same lever as
        # setting it by hand -- not a second, separately-drifting rule.
        env["CASCADE_MAX_DEPTH"] = str(cascade_depth)
        log(f"cascade depth for this run: {cascade_depth}")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(APP, "serve.py"), str(PORT)],
        cwd=APP, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env,
    )
    # serve.py only starts listening AFTER llama-server answers, so the port
    # opening is the model being ready -- no separate readiness check needed.
    #
    # Loading a multi-GB model is the longest wait in the whole run and the
    # most natural moment to change your mind, so the interrupt is caught HERE
    # rather than by the caller: until this function returns, `proc` exists
    # only inside it, and an Aborted let through would leave serve.py (and the
    # llama-server it just started) running with nothing holding a handle to
    # it.
    tail = []
    _relay_output(proc, tail, verbose)
    deadline = time.time() + 15 * 60
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
                time.sleep(0.3)   # let the relay thread drain the last of it
                raise RuntimeError("serve.py exited before listening: " +
                                   " / ".join(tail[-4:] or ["no output"]))
            if port_open(PORT):
                log("serve.py is up")
                return proc
            time.sleep(1)
    except BaseException:
        begin_cleanup()
        stop_serve(proc)
        raise
    stop_serve(proc)
    raise RuntimeError("serve.py never started listening within 15 minutes")


def stop_serve(proc):
    """Stop serve.py, then say what is actually still running.

    Real bug report: "the server wasn't closed automatically. I closed it when
    the program said that the changes have been pushed. Therefore I must have
    been misled into closing the server." Two things were hiding here. serve.py
    only stops the llama-server IT started -- one that was already up when it
    launched is deliberately left alone (see its start_llama_server) -- and
    every word serve.py said about that went into a pipe nobody read. So the
    honest thing is to check the ports afterwards and report what is left,
    rather than printing "stopped" and letting the rest be a surprise.
    """
    if proc is None:
        return
    if proc.poll() is None:
        log("stopping serve.py (SIGTERM -- its handler stops the llama-server it started)")
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=90)
        except subprocess.TimeoutExpired:
            log("serve.py did not exit in 90s; killing it")
            proc.kill()
            proc.wait(timeout=20)
    time.sleep(0.5)   # let the relay thread print serve.py's last lines first
    if port_open(PORT):
        log(f"serve.py did NOT let go of :{PORT} -- something is still listening there")
    else:
        log("serve.py stopped")
    if port_open(LLAMA_PORT):
        log(f"llama-server is STILL RUNNING on :{LLAMA_PORT} -- it was already up before "
            "this run, so serve.py left it alone. Nothing here will stop it; close it "
            "yourself if you want the memory back.")
    else:
        log("llama-server is down too -- nothing left running from this run")


# ----------------------------------------------------------------- the pass --
def run_pass(targets, budget_seconds, per_node_seconds, settle_seconds=300, quiet_seconds=60,
             labels=None):
    """Drives the real UI: turn on LLM Check, open each target, wait for its
    entry to land. Opening a node with the check armed is exactly what a human
    does, and it is the code path that ships -- no second implementation to
    drift from it."""
    from playwright.sync_api import sync_playwright   # imported late so --help works without it

    done, errors, skipped = [], [], []
    started = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True,
                                    args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])
        # Every exit from here on closes the browser, an interrupt included --
        # a headless Chromium left running holds the page (and its pending
        # fetches to llama-server) open behind the shutdown. See Aborted.
        try:
            return _run_pass_in(browser, targets, budget_seconds, per_node_seconds,
                                settle_seconds, quiet_seconds, done, errors, skipped, started,
                                labels)
        finally:
            begin_cleanup()
            try:
                browser.close()
            except Exception:
                pass


def _run_pass_in(browser, targets, budget_seconds, per_node_seconds,
                 settle_seconds, quiet_seconds, done, errors, skipped, started, labels=None):
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)[:200]))
        # ?agent=1: the page recovers its persisted scan queue at boot but does
        # NOT start it, because every decision this run makes has to be stamped
        # "agent" first and that happens below, after the page has loaded. See
        # llm_families.js's jobsAllowed.
        page.goto(f"http://localhost:{PORT}/index.html?agent=1", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)

        if not page.evaluate("() => !!(window.LlmFamilies && window.LlmFamilies.serverAvailable)"):
            # run_pass's finally closes the browser on every exit, this one
            # included -- see its comment.
            raise RuntimeError("the page cannot see serve.py's API, so nothing could be saved")

        arm_llm_check(page)

        # Every confirmation this run makes gets stamped decidedBy:"agent", so
        # a split nobody looked at is distinguishable afterwards from one a
        # human approved. Without it a bad run is archaeology.
        page.evaluate("() => window.LlmFamilies.setDecisionSource('agent')")
        if page.evaluate("() => window.LlmFamilies.decisionSource()") != "agent":
            raise RuntimeError("this build cannot stamp agent decisions -- refusing to "
                               "confirm anything unattributed")

        # Only now is it safe to let the queue run. It may already hold
        # requests a person left in it at the keyboard (the Tools > Scan Queue
        # panel writes them into llm_families.json), and those are worked
        # through in the order they were asked for, ahead of this run's own
        # targets -- which is the point of the queue.
        # NOT named `started`: that is this run's start timestamp, a parameter
        # of this function, and the budget check below subtracts it from the
        # clock. Shadowing it with a queue length of 0 made "now minus zero"
        # larger than any budget, so every target was silently skipped and
        # every requested scan came back having done nothing.
        queued_already = page.evaluate(
            "() => { const LF = window.LlmFamilies; "
            "if (!LF || !LF.startJobs) return null; LF.startJobs(); "
            "return LF.jobs().length; }")
        if queued_already:
            log(f"scan queue: {queued_already} request(s) already waiting -- those run first")

        # The cascade a previous run queued and never got to -- a crash, a
        # Ctrl+C, the budget. Written down as it was queued (see the page's
        # resumeCascade), so it is picked back up here rather than lost.
        resumed = page.evaluate(
            "() => { const LF = window.LlmFamilies; "
            "return LF && LF.resumeCascade ? LF.resumeCascade(CarWeb.nodes) : 0; }")
        if resumed:
            log(f"resuming: {resumed} car(s) an earlier run queued and never got to")

        depth = page.evaluate("() => window.LlmFamilies.cascadeMaxDepth()")
        rows_before = entry_rows(page)
        entries_before = len(rows_before)
        agent_before = agent_confirmed(page)
        log(f"cascade depth {depth}; {entries_before} cars already have an entry")

        if not targets and resumed:
            # Nothing new to open: the resumed cascade IS the pass.
            settle_cascade(page, settle_seconds, quiet_seconds)

        for nid in targets:
            spent = time.time() - started
            if spent > budget_seconds:
                # Said out loud. This was silent, and when a bug put `started`
                # at zero it skipped every target without a word -- which
                # looked from the outside like the model finding nothing.
                log(f"SKIPPED [{nid}] -- {spent / 60:.0f} min spent, past the "
                    f"{budget_seconds / 60:.0f} min budget")
                skipped.append(nid)
                continue
            exists = page.evaluate("(id) => !!CarWeb.byId.get(id)", nid)
            if not exists:
                # Real bug report: a scan requested from the phone came back
                # "done: nothing found" with no other trace. The node named in
                # the request was not in this graph -- a rebuild, a merge or a
                # reset can retire or rename one between the request being
                # made and the machine waking up -- and the run skipped it
                # without saying which one or why.
                #
                # The request also carries the car's NAME, which does not go
                # stale the way an id does, so that is tried before giving up.
                label = (labels or {}).get(nid)
                found = None
                if label:
                    found = page.evaluate(
                        "(q) => { const hits = (CarWeb.searchAll(q) || [])"
                        ".filter(n => !n.retired && CarWeb.llmJobSpecFor && CarWeb.llmJobSpecFor(n)); "
                        "return hits.length ? hits[0].id : null; }", label)
                if found:
                    log(f"{label}: the requested id [{nid}] is not in this graph any more -- "
                        f"matched it by name to [{found}] instead")
                    nid = found
                else:
                    log(f"SKIPPED [{nid}]" + (f" ({label})" if label else "") +
                        " -- no such car in this graph. It was probably renamed, merged "
                        "or cleared since the request was made; ask for it again from the "
                        "graph as it is now.")
                    skipped.append(nid)
                    continue
            name = page.evaluate(
                "(id) => { const n = CarWeb.byId.get(id); "
                "return n ? ((n.make ? n.make + ' ' : '') + n.label) : id; }", nid)
            kind = page.evaluate(
                "(id) => { const n = CarWeb.byId.get(id); return n ? n.type : null; }", nid)
            # Real user request: "The 'Request Scan' button should once again be
            # the only button that allows the user to do a scan of an existing
            # entry, including for engines." An engine is not checked the way a
            # car is -- there are no generations to split -- so the queue used
            # to accept one and then sit there until the per-node timeout.
            # Reading its article is the equivalent pass: variants, and every
            # car each variant went into.
            log(f"{name}  [{nid}] -- opening" + (" (engine)" if kind == "engine" else ""))
            # Both kinds go through the page's own work queue now, which is
            # what keeps this run from starting a pass on top of one a person
            # left waiting, or on top of the previous target's own cascade.
            # requestScan picks the same pass the car's own card would: an
            # engine's article for an engine, a nameplate re-check for a
            # nameplate, a hidden-generation check for a plain model. The node
            # is opened first because the cascade measures depth from whatever
            # is engaged, and an engine read is pinned to the node so a
            # redirect ("Mercedes-Benz M177 engine" ->
            # ".../M176/M177/M178 engine") cannot land the result on a
            # different id and leave this wait hanging forever.
            queued = page.evaluate(
                "(id) => { const n = CarWeb.byId.get(id); if (!n) return null; "
                "CarWeb.openDetail(n); "
                "if (CarWeb.requestScan) { const j = CarWeb.requestScan(n); "
                "return j ? (j.duplicate ? 'already-queued' : 'queued') : 'not-scannable'; } "
                "if (n.type === 'engine') CarWeb.scanEngine(n.wp || n.label, null, n); "
                "return 'legacy'; }", nid)
            if queued in ("not-scannable", None):
                skipped.append(nid)
                continue
            settled = False
            said = ""
            # The timeout is IDLE time, not total time. A local 9B model on a
            # long multi-generation article can run for many minutes, and the
            # first real run proved it: the Buick Century was cut off at a flat
            # 180s while four of its partners had already been written -- the
            # work was plainly in progress and the clock did not care. Any new
            # entry appearing is proof the model is still going, so it resets
            # the clock; the overall --budget-minutes is what actually bounds
            # the run.
            deadline = time.time() + per_node_seconds
            last_rows = entry_rows(page)
            while time.time() < deadline and time.time() - started < budget_seconds:
                page.wait_for_timeout(1000)
                state = page.evaluate(
                    """(id) => {
                      const LF = window.LlmFamilies;
                      const e = LF.entryFor(id), r = LF.recheckEntryFor(id);
                      const g = LF.engineEntryFor ? LF.engineEntryFor(id) : null;
                      return { status: (e && e.status) || null, recheck: (r && r.status) || null,
                               engine: (g && g.status) || null };
                    }""", nid)
                if state["status"] or state["recheck"] or state["engine"]:
                    settled = True
                    st = (state["status"] or state["engine"]
                          or ("recheck:" + state["recheck"]))
                    done.append((nid, st))
                    rows = entry_rows(page)
                    log(f"  {name} -- {describe(rows.get(nid, {'status': st}))}")
                    last_rows = rows
                    break
                # The app's own status line, echoed only when it changes -- so
                # the terminal says what the browser would be showing rather
                # than a bare counter.
                act = activity(page)
                if act and act != said:
                    log(f"  {name} -- {act}")
                    said = act
                rows = entry_rows(page)
                if len(rows) != len(last_rows):
                    report_new(rows, last_rows, "cascade")
                    last_rows = rows
                    deadline = time.time() + per_node_seconds
            if not settled:
                errors.append(f"{nid}: nothing written for {per_node_seconds}s, gave up on it")
                log(f"  {name} -- gave up, nothing written for {per_node_seconds}s")
            # A seed's own answer landing is NOT the end of the work. Confirming
            # a split kicks off the partner cascade -- that is what the depth
            # budget governs -- and those checks run in the background, after
            # this point. Stopping serve.py here would cut them off mid-flight
            # and lose calls already paid for. Runs even after a timeout, for
            # exactly the case above: the seed gave up but its partners were
            # still being written.
            settle_cascade(page, settle_seconds, quiet_seconds)

        rows_after = entry_rows(page)
        entries_after = len(rows_after)
        # The seeds are not the only cars this run can have SPLIT. A seed's
        # cascade confirms its partners the same way, by the same rule, and
        # the first real run proved it: the commit named only the Buick
        # Century while the LaCrosse and the Invicta had also been split and
        # applied. Reporting the seeds alone is exactly the reviewability gap
        # the decidedBy stamp exists to close, so read the stamp back rather
        # than inferring from the target list.
        agent_split = [i for i in agent_confirmed(page) if i not in agent_before]
        return done, errors, skipped, {
        "depth": depth, "before": entries_before, "after": entries_after,
        "cascaded": max(0, entries_after - entries_before - len(done)),
        "agent_split": agent_split,
        "rows": rows_after,
    }


def arm_llm_check(page):
    """Turn on 🤖 LLM Check.

    It is a menu ITEM, not a top-level button: every LLM tool moved into the
    Tools dropdown, and #toolsmenu is hidden until that dropdown is opened.
    Clicking #llmcheck straight away therefore waits 30 seconds for an element
    that exists, resolves, and is never visible -- which is exactly how this
    failed the first time it was run for real.
    """
    if page.evaluate("() => CarWeb.llmCheckOn()"):
        return
    try:
        page.click("#toolsmenu-btn", timeout=10000)
        page.wait_for_timeout(250)
        page.click("#llmcheck", timeout=10000)
        page.wait_for_timeout(400)
    except Exception as e:
        log(f"could not click the toggle ({str(e).splitlines()[0]}); setting it directly")
    if not page.evaluate("() => CarWeb.llmCheckOn()"):
        # Same function the click handler calls. Reached only when the menu
        # itself would not cooperate, so the check still runs rather than the
        # whole job failing over a dropdown.
        page.evaluate("() => CarWeb.setLlmCheck(true)")
        page.wait_for_timeout(300)
    if not page.evaluate("() => CarWeb.llmCheckOn()"):
        raise RuntimeError("could not arm the LLM check toggle")


def agent_confirmed(page):
    """Ids this session has confirmed and stamped decidedBy:"agent"."""
    return set(page.evaluate(
        """() => {
          const LF = window.LlmFamilies;
          return ((LF.allEntries && LF.allEntries()) || [])
            .map(e => e.id)
            .filter(id => { const x = LF.entryFor(id); return x && x.decidedBy === "agent"; });
        }"""))


def entry_rows(page):
    """Every car that has an entry -- a split decision or a pending re-check --
    with a readable name and what happened to it. The cascade's own work shows
    up here and nowhere else, since the partners it reaches are never in the
    target list, so this doubles as the progress signal AND as the thing that
    lets a log line say "Buick LaCrosse" instead of "m-buick-lacrosse"."""
    return page.evaluate(
        """() => {
          const cw = window.CarWeb, LF = window.LlmFamilies;
          const ids = new Set([
            ...(((LF.allEntries && LF.allEntries()) || []).map(e => e.id)),
            ...(((LF.allRecheckEntries && LF.allRecheckEntries()) || []).map(e => e.id)),
          ]);
          const out = {};
          ids.forEach(id => {
            const n = cw.byId.get(id), e = LF.entryFor(id), r = LF.recheckEntryFor(id);
            const gens = (e && e.proposal && e.proposal.generations) || [];
            out[id] = {
              label: n ? ((n.make ? n.make + " " : "") + n.label) : id,
              status: (e && e.status) || (r ? "recheck:" + r.status : null),
              gens: gens.length,
            };
          });
          return out;
        }""")


def describe(row):
    st, gens = row.get("status"), row.get("gens") or 0
    if st == "confirmed":
        return f"split into {gens} generations" if gens else "split"
    if st == "provisional":
        return f"{gens} generations proposed, waiting for you" if gens else "waiting for you"
    if st and st.startswith("recheck"):
        return "generation list re-checked, waiting for you"
    if st == "none":
        return "no hidden generations"
    if st == "same-article":
        return "same article as another car -- nothing of its own to split"
    if st == "error":
        return "check failed"
    return st or "checked"


# The app's own activity line, which is the most honest progress there is --
# it is what a person sitting in front of the browser would be reading.
def activity(page):
    txt = page.evaluate(
        """() => {
          const el = document.querySelector('#detail .llm-status');
          return el ? el.textContent : '';
        }""")
    txt = " ".join((txt or "").split())
    for junk in ("\U0001f916", "\u2026"):
        txt = txt.replace(junk, "")
    txt = txt.strip(" .\u2026")
    # Cut on a word boundary. A flat slice produced lines ending "against
    # Wikipedi", which reads like the app crashed mid-sentence.
    if len(txt) <= 64:
        return txt
    cut = txt[:64].rsplit(" ", 1)[0]
    return (cut or txt[:64]) + "\u2026"


def report_new(now, before, why):
    for nid in now:
        if nid not in before:
            log(f"    + {now[nid]['label']} -- {describe(now[nid])}  ({why})")


def pending_work(page):
    """What the page still has outstanding: checks in flight, partners queued
    behind them, article lookups a newly-minted car is waiting on. The app
    reports this directly (see llm_families.js's pendingWork) rather than it
    being guessed from how fast entries are appearing."""
    try:
        return page.evaluate(
            """() => {
              const LF = window.LlmFamilies;
              const p = LF && LF.pendingWork ? LF.pendingWork() : null;
              if (!p) return null;
              const cw = window.CarWeb;
              const name = id => { const n = cw.byId.get(id);
                return n ? ((n.make ? n.make + " " : "") + n.label) : id; };
              return { total: p.total,
                       names: [...p.checks, ...p.partners, ...p.lookups].map(name) };
            }""")
    except Exception:
        return None


def settle_cascade(page, settle_seconds, quiet_seconds=60):
    """Wait until the background partner checks have actually stopped.

    Three earlier versions got the "stopped" test wrong, the first two in the
    same way. Both counted STORED ENTRIES: one declared the cascade over after
    9 seconds of no new ones, the next after a minute. But a check writes
    nothing for its whole duration -- on a long article and a local model that
    is minutes, which is why the per-car timeout is 600 seconds -- so a minute
    of no writes is the normal middle of a single check, not the end of the
    work.

    Real bug report, the Dacia Duster: its article named the Renault Captur,
    the match was stored, and the Captur stayed a plain model with no entry at
    all. Its check was queued and running when the browser closed. The cascade
    had not declined it; the run walked out on it.

    So the page is asked what it still has outstanding (pendingWork) instead of
    being watched from outside. Nothing counts as quiet while a check is in
    flight or a partner is queued behind one.

    The third mistake was this function's own clock. settle_seconds was a
    TOTAL: a cascade of eight partners at two minutes each ran past it and got
    cut off exactly like before, just later. It is an IDLE cap now, the same
    shape --node-timeout already has: any progress -- an entry written, or the
    set of cars being worked on changing -- puts it back to zero, so the cap
    only ever fires on a page that is genuinely stuck, and a cascade that
    keeps finishing cars keeps its licence to run. --budget-minutes is what
    bounds the run as a whole.
    """
    last, idle, quiet, said = entry_rows(page), 0, 0, None
    working = None
    while idle < settle_seconds:
        page.wait_for_timeout(3000)
        idle += 3
        now = entry_rows(page)
        if len(now) != len(last):
            report_new(now, last, "cascade")
            last, quiet, idle = now, 0, 0     # a car finished: real progress
        pend = pending_work(page)
        if pend and pend["total"]:
            quiet = 0
            names = ", ".join(pend["names"][:4])
            more = pend["total"] - min(4, len(pend["names"]))
            line = f"  still working on {names}" + (f" (+{more} more)" if more > 0 else "")
            # Moving on to a different car is progress too, even before it
            # writes anything -- otherwise a cascade whose cars each take
            # longer than the cap would still be cut off partway through.
            if pend["names"] != working:
                working, idle = pend["names"], 0
            if line != said:
                log(line)
                said = line
            continue
        working = None
        # pendingWork is None on a build that predates it -- fall back to the
        # old count-and-wait rather than refusing to settle at all.
        if len(now) == len(last):
            quiet += 3
            if quiet >= quiet_seconds:
                return
    log(f"  nothing has moved for {settle_seconds}s; moving on")
    pend = pending_work(page)
    if pend and pend["total"]:
        log(f"  {pend['total']} check(s) were still running and will be lost: "
            + ", ".join(pend["names"][:8]))


# ------------------------------------------------------------------- git -----
def git(*args, check=True):
    r = subprocess.run(["git"] + list(args), cwd=ROOT, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError("git " + " ".join(args) + ": " + (r.stderr or r.stdout).strip())
    return r.stdout.strip()


def push_result(summary, detail=""):
    """Commits only the two files the pass can write, and only if they moved.

    Never `git add -A`: this runs unattended in a working tree that may have
    anything else half-finished in it, and committing that on someone's behalf
    is not this script's business.
    """
    changed = [f for f in TRACKED if git("status", "--porcelain", "--", f)]
    if not changed:
        log("nothing changed on disk, so nothing to push")
        return False
    git("add", *changed)
    subprocess.run(
        ["git", "-c", "user.name=quirksandfeats", "-c", "user.email=goldenberg.andy@gmail.com",
         "commit", "-q", "-m",
         "LLM pass from a queued scan request\n\n" + summary + ("\n\n" + detail if detail else "")],
        cwd=ROOT, check=True)
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    log(f"pushing {branch}")
    git("push", "origin", branch)
    return True


# ------------------------------------------------------------------ the run --
def do_job(job, args):
    jid = job["id"] if job else None
    if job:
        status, d = api("/api/request/claim", "POST", {"id": jid})
        if status == 409:
            log("another agent claimed that job first")
            return
        if status != 200:
            log(f"could not claim the job ({status}); leaving it for next time")
            return

    seed_labels = {}
    if getattr(args, "resume", False):
        # The saved cascade is the whole of the work; the page picks it up.
        targets = []
    elif args.targets:
        # An explicit list is taken as given -- including nodes that already
        # have an entry, since "check this one again" is the whole reason to
        # name it by hand.
        targets = [t.strip() for t in args.targets.split(",") if t.strip()][: args.seeds]
    elif job and job.get("targetId"):
        # A queued request names the car. Someone stood in front of the graph,
        # focused this one and asked for it, so it is the seed -- not the top
        # of the backlog, and not filtered out for already having an entry,
        # since "look at this again" is a perfectly good request.
        targets = [job["targetId"]]
        seed_labels = {job["targetId"]: job.get("targetLabel") or ""}
        log(f"requested car: {job.get('targetLabel') or job['targetId']} [{job['targetId']}]")
    else:
        targets = [nid for nid in review_queue_ids() if nid not in already_scanned()][: args.seeds]
    if not targets and not getattr(args, "resume", False):
        finish(jid, "done", "nothing left in the review queue to scan")
        return

    log(f"{len(targets)} seed(s), budget {args.budget_minutes} min")
    proc, state, summary, detail, user_summary = None, "done", "", "", ""
    try:
        proc = start_serve(args.cascade_depth, verbose=getattr(args, "verbose", False))
        done, errors, skipped, cascade = run_pass(
            targets, args.budget_minutes * 60, args.node_timeout,
            args.settle_seconds, args.settle_quiet, seed_labels)
        cascade_stats = cascade
        split = cascade.get("agent_split") or [nid for nid, st in done if st == "confirmed"]
        waiting = [nid for nid, st in done if st == "provisional" or (st or "").startswith("recheck")]
        nothing = [nid for nid, st in done
                   if st in ("rejected", "none", "error", "same-article")]
        bits = [f"{len(done)} seed(s) at cascade depth {cascade['depth']}",
                f"{cascade['after']} cars now have an entry"]
        if cascade["cascaded"]:
            bits.append(f"{cascade['cascaded']} reached by the cascade")
        if split:
            bits.append(f"{len(split)} split")
        if waiting:
            bits.append(f"{len(waiting)} awaiting your review")
        if nothing:
            bits.append(f"{len(nothing)} found nothing")
        if skipped:
            bits.append(f"{len(skipped)} skipped")
        if errors:
            bits.append(f"{len(errors)} errored")
        # A run that wrote nothing at all failed. One that timed out on its
        # seed but still recorded four partner checks, pushed them, and left
        # them on the site did not -- calling that "failed" sent me looking
        # for a broken run when the actual problem was a too-short timeout.
        if errors and not done and cascade_stats["after"] <= cascade_stats["before"]:
            state = "failed"
        # "3 split" does not tell you WHICH three, and finding out meant
        # diffing the JSON. The queue caps a summary at 400 characters, so the
        # short list goes there and the full one goes in the commit body.
        summary = ", ".join(bits) + name_list("split", split) + name_list("awaiting review", waiting)
        detail = commit_body(split, waiting, nothing, skipped, errors)
        # What the person who pressed the button sees. They asked about ONE
        # car; "104 cars now have an entry, 11 reached by the cascade" is a
        # log line, not an answer. The long version stays in the terminal and
        # in the commit, where it is actually useful.
        if job and job.get("targetId"):
            row = (cascade.get("rows") or {}).get(job["targetId"])
            if row:
                user_summary = describe(row)
            elif skipped and not done:
                # "nothing found" is what a car that WAS looked at and had no
                # hidden generations says. A car that could not be found at all
                # is a different answer, and saying the first one sent me
                # looking for a broken model when the request simply named a
                # node this graph no longer has.
                user_summary = (f"couldn't find \"{job.get('targetLabel') or job['targetId']}\" "
                                "in the graph -- it may have been renamed, merged or cleared "
                                "since you asked. Try asking for it again.")
            else:
                user_summary = "nothing found"
        else:
            user_summary = summary
        log(summary)
        for e in errors[:10]:
            log("  " + e)
    except Aborted:
        # Ctrl+C. The work already written to llm_families.json is real and
        # already paid for in model time, so it is still pushed below -- the
        # only difference from a normal finish is that the run is reported as
        # not having completed, and the car may still have partners nobody
        # looked at.
        state = "failed"
        summary = ("stopped by hand before it finished" +
                   (f"; {summary}" if summary else ""))[:380]
        user_summary = "the scan was stopped before it finished"
    except Exception as e:
        state, summary = "failed", str(e)[:300]
        user_summary = "the scan failed"
        log("FAILED: " + summary)
    finally:
        begin_cleanup()
        stop_serve(proc)

    try:
        push_result(summary or "no summary", detail)
    except Exception as e:
        state = "failed"
        summary = (summary + f"; push failed: {e}")[:380]
        user_summary = "the scan finished but could not be published"
        log("push failed: " + str(e))

    log(summary)
    finish(jid, state, user_summary or summary)
    # --watch would otherwise take the next job off the queue and start all
    # over again: do_job swallowed the interrupt so it could still push and
    # report, which means main() has to be told the run is over.
    if STOPPING:
        raise Aborted()


def finish(jid, state, summary):
    log(f"{state}: {summary}")
    if jid:
        _, d = api("/api/request/done", "POST", {"id": jid, "state": state, "summary": summary})
        waiting = d.get("waiting") if isinstance(d, dict) else None
        if waiting:
            log(f"{waiting} more request(s) still waiting")


def main():
    ap = argparse.ArgumentParser(description="Run a queued Car Web LLM scan.")
    ap.add_argument("--watch", action="store_true", help="keep waiting for jobs instead of giving up")
    ap.add_argument("--now", action="store_true", help="scan immediately without waiting for a job")
    ap.add_argument("--resume", action="store_true",
                    help="pick up the cascade an earlier run queued and never finished "
                         "(a crash, Ctrl+C, the budget), then commit and push as usual")
    ap.add_argument("--poll-seconds", type=int, default=60)
    ap.add_argument("--wait-minutes", type=int, default=10, help="how long --once waits for a job")
    # How many cars a run scans is governed by the CASCADE, not by a count
    # here: one seed pulls in whatever its own article names, out to the depth
    # serve.py is configured for. That is the same budget a click gets, so the
    # agent spends the model exactly the way a person does. --seeds is only how
    # many places it starts from.
    ap.add_argument("--seeds", type=int, default=1,
                    help="how many backlog cars to start from (the cascade decides "
                         "how many get scanned from each)")
    ap.add_argument("--cascade-depth", type=int, default=None,
                    help="override serve.py's CASCADE_MAX_DEPTH for this run "
                         "(default: whatever serve.py is already set to)")
    ap.add_argument("--settle-seconds", type=int, default=900,
                    help="give up on a seed's cascade after this many seconds with NO "
                         "progress at all; any car finishing, or the cascade moving on "
                         "to a different car, resets it")
    ap.add_argument("--settle-quiet", type=int, default=60,
                    help="how many seconds with nothing new written counts as the "
                         "cascade being finished")
    ap.add_argument("--budget-minutes", type=int, default=45, help="wall-clock cap on the scanning phase")
    ap.add_argument("--node-timeout", type=int, default=600,
                    help="give up on one car after this many seconds with NOTHING new "
                         "written; any new entry resets it")
    ap.add_argument("--targets", default="", help="comma-separated node ids to scan instead of the review backlog")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what a run would scan and stop; starts nothing")
    # Managing the queue from here rather than from the site: the site can
    # only drop one request at a time, on purpose (see the Worker's own
    # comment on why emptying it is agent-token-only).
    ap.add_argument("--verbose", action="store_true",
                    help="relay serve.py's full output (HTTP requests, per-token "
                         "generation progress) instead of just the scan's own lines")
    ap.add_argument("--queue", action="store_true", help="list the queued requests and stop")
    ap.add_argument("--drop", default="", metavar="ID_OR_CAR",
                    help="remove one queued request, by job id or by the car's node id")
    ap.add_argument("--clear", action="store_true",
                    help="remove every queued request (anything already running is left alone)")
    ap.add_argument("--release", nargs="?", const="", default=None, metavar="ID_OR_CAR",
                    help="hand back a request that is stuck marked running -- it goes to the "
                         "back of nothing, keeps its place, and the next run claims it again. "
                         "With no value, the one currently marked running.")
    args = ap.parse_args()

    if shutil.which("git") is None:
        sys.exit("git is not on PATH")
    if args.queue or args.drop or args.clear or args.release is not None:
        if not TOKEN:
            sys.exit(NO_TOKEN)
        if args.release is not None:
            st, d = api("/api/request/release", "POST", {"id": args.release})
            if st != 200:
                sys.exit(f"could not release that ({st}): {d.get('message') or d.get('error')}")
            j = (d or {}).get("job") or {}
            print(f"released {j.get('targetLabel') or j.get('targetId') or 'it'} "
                  f"-- waiting again, the next run picks it up")
        elif args.clear:
            st, d = api("/api/request/cancel", "POST", {"all": True})
            if st != 200:
                sys.exit(f"could not clear the queue ({st}): {d.get('message') or d.get('error')}")
            print(f"removed {d.get('removed', 0)} request(s)")
        elif args.drop:
            st, d = api("/api/request/cancel", "POST", {"id": args.drop})
            if st == 409 and (d or {}).get("error") == "running":
                # It is marked running. From here -- with the agent token, on
                # the machine that does the scanning -- that claim is ours to
                # break: either this run left it behind or no run did. Hand it
                # back, then remove it, so --drop means dropped either way.
                rs, _ = api("/api/request/release", "POST", {"id": args.drop})
                if rs == 200:
                    st, d = api("/api/request/cancel", "POST", {"id": args.drop})
            if st != 200:
                sys.exit(f"could not remove that ({st}): {d.get('message') or d.get('error')}")
            print("removed 1 request")
        else:
            st, d = api("/api/request/status")
            if st != 200:
                sys.exit(f"could not read the queue ({st})")
        q = (d or {}).get("queue") or []
        if not q:
            print("queue is empty")
        for i, j in enumerate(q, 1):
            state = " (running now)" if j.get("state") == "running" else ""
            print(f"{i}. {j.get('targetLabel') or j.get('targetId')}{state}")
            print(f"   id {j.get('id')}   queued {j.get('queuedAt')}")
        last = (d or {}).get("last")
        if last:
            print(f"\nlast run: {last.get('targetLabel') or '?'} -- {last.get('state')}"
                  f" -- {last.get('summary') or ''}")
        return

    if args.dry_run:
        backlog = review_queue_ids()
        scanned = already_scanned()
        todo = [n for n in backlog if n not in scanned]
        print(f"review backlog:      {len(backlog)} cars (from {os.path.relpath(REPORT, ROOT)})")
        print(f"already have an entry: {len(backlog) - len(todo)}")
        print(f"cascade depth:       serve.py's setting"
              + (f", overridden to {args.cascade_depth} for this run" if args.cascade_depth is not None else ""))
        print(f"\nwould start from {min(args.seeds, len(todo))} seed(s):")
        for nid in todo[: args.seeds]:
            print("  " + nid)
        print("\nnext in line after that:")
        for nid in todo[args.seeds: args.seeds + 8]:
            print("  " + nid)
        return
    if args.resume:
        n = saved_cascade_count()
        if not n:
            print("nothing saved to resume -- every car the cascade queued has been checked")
            return
        log(f"resuming {n} car(s) the cascade queued and never checked")
        do_job(None, args)
        return
    if args.now:
        do_job(None, args)
        return
    if args.watch:
        n = saved_cascade_count()
        if n:
            log(f"note: {n} car(s) left over from an earlier cascade -- the next pass picks "
                "them up first, or run --resume to do just those now")
    if not TOKEN:
        sys.exit(NO_TOKEN)

    while True:
        job = wait_for_job(args.poll_seconds, 0 if args.watch else args.wait_minutes * 60)
        if job is None:
            log("no job appeared")
            return
        log(f"claiming job {job['id'][:8]} queued at {job.get('queuedAt')}")
        do_job(job, args)
        if not args.watch:
            return
        # Straight back round without the poll delay: a queue with several
        # cars in it should drain, not tick over once a minute.
        continue


if __name__ == "__main__":
    install_signal_handlers()
    try:
        main()
    except Aborted:
        # Everything that needed closing has closed by the time this is
        # reached -- do_job's own finally stops serve.py, run_pass's closes
        # the browser. All that is left is to say so and use the conventional
        # interrupted exit code, with no traceback.
        log("stopped")
        sys.exit(130)
    except KeyboardInterrupt:
        # Only reachable in the sliver between the interpreter starting and
        # the handler being installed. Same ending, still no traceback.
        sys.exit(130)
