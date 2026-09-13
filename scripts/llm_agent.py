#!/usr/bin/env python3
"""The Car Web — request-queue agent.

Picks up a scan job left by the hosted site's "⚡ Request scan" button, runs
the local LLM generation pass, pushes the result, and exits.

    export CARWEB_AGENT_TOKEN='...'        # the AGENT_TOKEN secret
    python3 scripts/llm_agent.py           # wait up to 10 min for a job, run it
    python3 scripts/llm_agent.py --watch   # keep waiting (for launchd/cron)
    python3 scripts/llm_agent.py --now     # run a scan immediately, no job

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
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
REPORT = os.path.join(ROOT, "data_src", "harvest", "family_match_report.txt")
LLM_FAMILIES = os.path.join(APP, "llm_families.json")

QUEUE = os.environ.get("CARWEB_QUEUE_URL", "https://carweb.quirksandfeats.workers.dev")
TOKEN = os.environ.get("CARWEB_AGENT_TOKEN", "")
PORT = int(os.environ.get("CARWEB_PORT", "8077"))

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
    for label, ids in (("Split and applied without review", split),
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


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


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
            # it claimed. Don't stampede it.
            log(f"job {job['id'][:8]} is already marked running; leaving it alone")
        if give_up_after and time.time() - started >= give_up_after:
            return None
        time.sleep(poll_seconds)


# -------------------------------------------------------------- the targets --
def review_queue_ids(path=None):
    """Node ids from the family report's two review sections.

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


def start_serve():
    if port_open(PORT):
        sys.exit(f"something is already listening on :{PORT} -- stop it first, "
                 "so this script doesn't drive a server it cannot shut down")
    log("starting serve.py (it starts llama-server itself, and the model load "
        "can take a minute)")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(APP, "serve.py"), str(PORT)],
        cwd=APP, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    # serve.py only starts listening AFTER llama-server answers, so the port
    # opening is the model being ready -- no separate readiness check needed.
    deadline = time.time() + 15 * 60
    while time.time() < deadline:
        if proc.poll() is not None:
            out = (proc.stdout.read() or "").strip().splitlines()
            raise RuntimeError("serve.py exited before listening: " +
                               " / ".join(out[-4:] or ["no output"]))
        if port_open(PORT):
            log("serve.py is up")
            return proc
        time.sleep(1)
    stop_serve(proc)
    raise RuntimeError("serve.py never started listening within 15 minutes")


def stop_serve(proc):
    if proc is None or proc.poll() is not None:
        return
    log("stopping serve.py (SIGTERM -- its handler stops llama-server too)")
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=90)
    except subprocess.TimeoutExpired:
        log("serve.py did not exit in 90s; killing it")
        proc.kill()
        proc.wait(timeout=20)
    log("serve.py stopped")


# ----------------------------------------------------------------- the pass --
def run_pass(targets, budget_seconds, per_node_seconds):
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
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)[:200]))
        page.goto(f"http://localhost:{PORT}/index.html", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)

        if not page.evaluate("() => !!(window.LlmFamilies && window.LlmFamilies.serverAvailable)"):
            browser.close()
            raise RuntimeError("the page cannot see serve.py's API, so nothing could be saved")

        if not page.evaluate("() => CarWeb.llmCheckOn()"):
            page.click("#llmcheck")
            page.wait_for_timeout(300)
        if not page.evaluate("() => CarWeb.llmCheckOn()"):
            browser.close()
            raise RuntimeError("could not arm the LLM check toggle")

        # Every confirmation this run makes gets stamped decidedBy:"agent", so
        # a split nobody looked at is distinguishable afterwards from one a
        # human approved. Without it a bad run is archaeology.
        page.evaluate("() => window.LlmFamilies.setDecisionSource('agent')")
        if page.evaluate("() => window.LlmFamilies.decisionSource()") != "agent":
            browser.close()
            raise RuntimeError("this build cannot stamp agent decisions -- refusing to "
                               "confirm anything unattributed")

        for nid in targets:
            if time.time() - started > budget_seconds:
                skipped.append(nid)
                continue
            exists = page.evaluate("(id) => !!CarWeb.byId.get(id)", nid)
            if not exists:
                # The report is regenerated by a rebuild; a node named in it
                # can have been merged away or deleted since.
                skipped.append(nid)
                continue
            log(f"checking {nid}")
            page.evaluate("(id) => { const n = CarWeb.byId.get(id); if (n) CarWeb.openDetail(n); }", nid)
            settled = False
            for _ in range(int(per_node_seconds * 2)):
                page.wait_for_timeout(500)
                state = page.evaluate(
                    """(id) => {
                      const LF = window.LlmFamilies;
                      const e = LF.entryFor(id), r = LF.recheckEntryFor(id);
                      return { status: (e && e.status) || null, recheck: (r && r.status) || null };
                    }""", nid)
                if state["status"] or state["recheck"]:
                    settled = True
                    done.append((nid, state["status"] or ("recheck:" + state["recheck"])))
                    break
            if not settled:
                errors.append(f"{nid}: no result within {per_node_seconds}s")
        browser.close()
    return done, errors, skipped


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
        if job.get("note"):
            log(f"requested: {job['note']}")

    if args.targets:
        # An explicit list is taken as given -- including nodes that already
        # have an entry, since "check this one again" is the whole reason to
        # name it by hand.
        targets = [t.strip() for t in args.targets.split(",") if t.strip()][: args.max_scans]
    else:
        targets = [nid for nid in review_queue_ids() if nid not in already_scanned()][: args.max_scans]
    if not targets:
        finish(jid, "done", "nothing left in the review queue to scan")
        return

    log(f"{len(targets)} node(s) to scan, budget {args.budget_minutes} min")
    proc, state, summary, detail = None, "done", "", ""
    try:
        proc = start_serve()
        done, errors, skipped = run_pass(targets, args.budget_minutes * 60, args.node_timeout)
        split = [nid for nid, st in done if st == "confirmed"]
        waiting = [nid for nid, st in done if st == "provisional" or (st or "").startswith("recheck")]
        nothing = [nid for nid, st in done if st in ("rejected", "none", "error")]
        bits = [f"{len(done)} scanned"]
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
            state = "failed" if not done else "done"
        # "3 split" does not tell you WHICH three, and finding out meant
        # diffing the JSON. The queue caps a summary at 400 characters, so the
        # short list goes there and the full one goes in the commit body.
        summary = ", ".join(bits) + name_list("split", split) + name_list("awaiting review", waiting)
        detail = commit_body(split, waiting, nothing, skipped, errors)
        log(summary)
        for e in errors[:10]:
            log("  " + e)
    except Exception as e:
        state, summary = "failed", str(e)[:300]
        log("FAILED: " + summary)
    finally:
        stop_serve(proc)

    try:
        if push_result(summary or "no summary", detail):
            summary += "; pushed"
    except Exception as e:
        state = "failed"
        summary = (summary + f"; push failed: {e}")[:380]
        log("push failed: " + str(e))

    finish(jid, state, summary)


def finish(jid, state, summary):
    log(f"{state}: {summary}")
    if jid:
        api("/api/request/done", "POST", {"id": jid, "state": state, "summary": summary})


def main():
    ap = argparse.ArgumentParser(description="Run a queued Car Web LLM scan.")
    ap.add_argument("--watch", action="store_true", help="keep waiting for jobs instead of giving up")
    ap.add_argument("--now", action="store_true", help="scan immediately without waiting for a job")
    ap.add_argument("--poll-seconds", type=int, default=60)
    ap.add_argument("--wait-minutes", type=int, default=10, help="how long --once waits for a job")
    ap.add_argument("--max-scans", type=int, default=12,
                    help="how many nodes one run may check (each is a real model call)")
    ap.add_argument("--budget-minutes", type=int, default=45, help="wall-clock cap on the scanning phase")
    ap.add_argument("--node-timeout", type=int, default=180, help="seconds to wait for one node's result")
    ap.add_argument("--targets", default="", help="comma-separated node ids to scan instead of the review queue")
    args = ap.parse_args()

    if shutil.which("git") is None:
        sys.exit("git is not on PATH")
    if args.now:
        do_job(None, args)
        return
    if not TOKEN:
        sys.exit("set CARWEB_AGENT_TOKEN to the AGENT_TOKEN secret")

    while True:
        job = wait_for_job(args.poll_seconds, 0 if args.watch else args.wait_minutes * 60)
        if job is None:
            log("no job appeared")
            return
        log(f"claiming job {job['id'][:8]} queued at {job.get('queuedAt')}")
        do_job(job, args)
        if not args.watch:
            return


if __name__ == "__main__":
    main()
