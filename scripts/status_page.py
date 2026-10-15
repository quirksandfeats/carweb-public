#!/usr/bin/env python3
"""CarWeb scan status: a one-page dashboard of a scan in progress.

Real user request (Oct 2026): a status page that "only starts when I turn on
the agent, and ends right when the agent no longer runs", built into the agent
rather than a second program to start and stop. scripts/llm_agent.py runs it:
it writes the page when the agent starts, every 15 minutes while it runs, and
a final report as the agent stops -- a finished queue, Ctrl+C or a crash.

Where the page goes is not in this repository: it is read from
scripts/agent_settings.local.json (git-ignored), for example

    {"statusPage": "/path/to/a/synced/folder/CarWeb scan status.html"}

and with no such file the agent writes no page. Two small files that keep the
page's history sit beside it, hidden. The last page of each run is also kept
as "CarWeb final report <date>.html".

    python3 scripts/status_page.py --out PATH   # write the page once, now

Standard library only. It reads the store, the queue and git; it never writes
to any of them.
"""
import datetime as dt
import html
import json
import os
import argparse
import re
import signal
import subprocess
import sys
import time
import unicodedata
import urllib.request
from collections import Counter

REPO = os.environ.get("CARWEB_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = OUT_DIR = HISTORY = REQUESTS = None
INTERVAL_MIN = 15
SETTINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_settings.local.json")

# What the agent tells the page directly, rather than leaving it to be read
# from the queue: the request it is working on, the one it last finished, and
# whether this is the final write. The queue service drops a request two days
# after it was queued, the running one included, and its finish was then never
# recorded there -- the Mazda CX-5's, on 14 Oct 2026.
AGENT = {"job": None, "last": None, "final": False, "pid": None}


def configure(out, repo=None):
    global OUT, OUT_DIR, HISTORY, REQUESTS, REPO
    if repo:
        REPO = repo
    OUT = os.path.abspath(out)
    OUT_DIR = os.path.dirname(OUT)
    HISTORY = os.path.join(OUT_DIR, ".carweb_status_history.jsonl")
    REQUESTS = os.path.join(OUT_DIR, ".carweb_status_requests.json")
    os.makedirs(OUT_DIR, exist_ok=True)


def configured_path():
    """The page's path from scripts/agent_settings.local.json, or None."""
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            p = (json.load(f) or {}).get("statusPage")
        return os.path.expanduser(p) if p else None
    except (OSError, ValueError):
        return None


# ------------------------------------------------------------------ reading
def read_json(path, tries=4):
    """The agent rewrites the store while this runs; a half-written file is
    read again rather than reported as broken."""
    last = None
    for _ in range(tries):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (ValueError, OSError) as e:
            last = e
            time.sleep(0.6)
    raise last


def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


def slug(t):
    t = unicodedata.normalize("NFKD", str(t))
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")


def queue_url():
    env = os.environ.get("CARWEB_QUEUE_URL")
    if env:
        return env
    try:
        src = open(os.path.join(REPO, "scripts", "llm_agent.py"), encoding="utf-8").read()
        m = re.search(r'CARWEB_QUEUE_URL",\s*"([^"]+)"', src)
        return m.group(1) if m else None
    except OSError:
        return None


def read_queue():
    url = queue_url()
    if not url:
        return None
    try:
        # The service turns away Python's default client name.
        req = urllib.request.Request(url.rstrip("/") + "/api/request/status",
                                     headers={"User-Agent": "carweb-status/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def parse_time(s):
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


# -------------------------------------------------------- finished requests
def track_requests(queue, fs, done, queued, now):
    """Remember each request while it runs, and what became of it.

    The queue only reports the one request that finished last, and the store
    only knows the one running now, so the list is kept here: a record is
    opened when a request is seen running and closed when the queue reports
    it finished. Whether its results were pushed is read from git.
    """
    try:
        log_ = json.load(open(REQUESTS, encoding="utf-8"))
    except (OSError, ValueError):
        log_ = {"since": now.isoformat(), "requests": []}
    # One run of the agent is one process. A new process is a new run: its
    # list of finished requests starts empty (the last run's final report is
    # kept as its own dated file).
    pid = [AGENT["pid"]] if AGENT["pid"] and not AGENT["final"] else \
        ([] if AGENT["final"] else sh("pgrep", "-f", "llm_agent.py").split()[:1])
    run = log_.get("run") or {}
    if pid and run.get("pid") != pid[0]:
        started = sh("ps", "-o", "lstart=", "-p", pid[0])
        try:
            started_at = dt.datetime.strptime(" ".join(started.split()), "%a %b %d %H:%M:%S %Y").astimezone().isoformat()
        except ValueError:
            started_at = now.isoformat()
        run = {"pid": pid[0], "startedAt": started_at}
        log_ = {"since": started_at, "requests": [], "run": run}
    elif not pid and run and not run.get("stoppedAt"):
        run["stoppedAt"] = now.isoformat()
    log_["run"] = run
    recs = log_["requests"]
    running = next((j for j in (queue or {}).get("queue") or [] if j.get("state") == "running"), None)
    if not running and AGENT["job"] and not AGENT["final"]:
        running = dict(AGENT["job"], state="running")
    current = None
    if running:
        rec = next((r for r in recs if r.get("id") == running.get("id")), None)
        if not rec:
            # The store's own scan record belongs to the request that started
            # it. When that request ends early (the Corolla's did, after the
            # browser page crashed too often) the next request carries its
            # unfinished cars along, under the OLD record: same seed, same
            # running count. So a request is told apart by the queue, and its
            # own count starts from where the last one stopped.
            own = fs.get("seed") and running.get("targetId") == fs.get("seed")
            prev = next((r for r in reversed(recs) if r.get("finishedAt")), None)
            rec = {"id": running.get("id"), "label": running.get("targetLabel") or running.get("targetId"),
                   "targetId": running.get("targetId")}
            if own:
                rec.update({"startedAt": fs.get("startedAt"), "baseline": 0})
            else:
                carried = prev if prev and prev.get("seed") == fs.get("seed") and (prev.get("done") or 0) <= done else None
                rec.update({"startedAt": (prev or {}).get("finishedAt") or now.isoformat(),
                            "baseline": carried["done"] if carried else done,
                            "carriedFrom": carried.get("label") if carried else None})
            recs.append(rec)
        if fs.get("seed") and running.get("targetId") == fs.get("seed") and rec.get("baseline"):
            rec["baseline"] = 0          # its own scan has started: the store counts for it now
            rec["carriedFrom"] = None
        rec.update({"done": done, "queued": queued, "seed": fs.get("seed")})
        current = rec
    for last in ((queue or {}).get("last") or {}, AGENT["last"] or {}):
        # As times, not text: "since" is local and a finish is UTC.
        fin, since = parse_time(last.get("finishedAt")), parse_time(log_.get("since"))
        if not (last.get("id") and fin and (not since or fin >= since)):
            continue
        rec = next((r for r in recs if r.get("id") == last["id"]), None)
        if not rec:
            rec = {"id": last["id"], "label": last.get("targetLabel") or "?", "startedAt": None}
            recs.append(rec)
        if not rec.get("finishedAt"):
            rec.update({"finishedAt": last["finishedAt"], "state": last.get("state"), "summary": last.get("summary") or ""})
    # pushed: the agent's commit for it is on the remote branch
    for rec in recs:
        if not rec.get("finishedAt") or rec.get("pushed"):
            continue
        since = rec.get("startedAt") or rec["finishedAt"]
        commits = sh("git", "-C", REPO, "log", "--since", since, "--format=%H", "--grep", "LLM pass from a queued scan request")
        if commits.split() and not rec.get("reason"):
            body = sh("git", "-C", REPO, "log", "-1", "--format=%b", commits.split()[-1]).strip().splitlines()
            rec["reason"] = body[0].strip() if body else ""
        rec["pushed"] = any(subprocess.run(["git", "-C", REPO, "merge-base", "--is-ancestor", h, "origin/HEAD"],
                                           capture_output=True).returncode == 0 or
                            subprocess.run(["git", "-C", REPO, "merge-base", "--is-ancestor", h, "origin/main"],
                                           capture_output=True).returncode == 0
                            for h in commits.split())
    try:
        tmp = REQUESTS + ".tmp"
        json.dump(log_, open(tmp, "w", encoding="utf-8"))
        os.replace(tmp, REQUESTS)
    except OSError:
        pass
    out = []
    for rec in recs:
        if not rec.get("finishedAt"):
            continue
        a, b = parse_time(rec.get("startedAt")), parse_time(rec.get("finishedAt"))
        out.append({"label": rec.get("label"), "state": rec.get("state") or "done",
                    "took": (b - a).total_seconds() if a and b else None,
                    "at": b.astimezone() if b else None, "pushed": bool(rec.get("pushed")),
                    "cars": (rec.get("done") or 0) - (rec.get("baseline") or 0) if rec.get("done") is not None else None,
                    "summary": rec.get("summary") or "", "reason": rec.get("reason") or ""})
    track_requests.run = dict(run)
    track_requests.current = dict(current) if current else None
    return out[::-1]


def final_report(d):
    """What to say once the agent has stopped: how the run ended, what it
    finished, and whether its results are on GitHub."""
    run = d.get("run") or {}
    fin = d["finished"]
    still_running = [q for q, st in d["queue"] if st == "running"]
    waiting = [q for q, st in d["queue"] if st != "running"]
    done = [r for r in fin if r["state"] == "done"]
    failed = [r for r in fin if r["state"] != "done"]
    a, b = parse_time(run.get("startedAt")), parse_time(run.get("stoppedAt"))
    lines = []
    if still_running:
        outcome, pill = "interrupted", "Interrupted"
        lines.append(f"The agent stopped while {still_running[0]} was still marked as running. That request did not finish.")
    elif waiting:
        outcome, pill = "stopped", "Stopped"
        lines.append(f"The agent stopped with {len(waiting)} request(s) still waiting: {', '.join(waiting)}.")
    elif not d["queue_ok"]:
        outcome, pill = "stopped", "Stopped"
        lines.append("The agent has stopped. The request queue could not be reached, so what is left in it is unknown.")
    elif failed:
        outcome, pill = "stopped", "Stopped"
        lines.append(f"The agent has stopped and the queue is empty, but {len(failed)} request(s) stopped before "
                     f"finishing: {', '.join(r['label'] for r in failed)}."
                     + (f" The {n(d['queued'])} cars they left are saved; run the agent with --resume to finish them."
                        if d.get("queued") else ""))
    else:
        outcome, pill = "completed", "Completed"
        lines.append("The agent has stopped and the queue is empty: every request is finished.")
    if a and b:
        lines.append(f"It ran from {a.astimezone().strftime('%a %d %b, %H:%M')} to {b.astimezone().strftime('%a %d %b, %H:%M')} "
                     f"({dur((b - a).total_seconds())}).")
    if fin:
        lines.append(f"Requests finished in this run: {len(done)}" + (f", plus {len(failed)} that failed or were stopped" if failed else "") + ".")
    else:
        lines.append("No request finished in this run.")
    not_pushed = [r["label"] for r in fin if not r["pushed"]]
    if d["unpushed"] or not_pushed:
        lines.append("Not everything is on GitHub: "
                     + (("results from " + ", ".join(not_pushed) + " were not pushed") if not_pushed else "the local store has changes that are not committed") + ".")
    elif fin:
        lines.append("All results are pushed to GitHub.")
    todo = []
    if d["waiting_rechecks"]:
        todo.append(f"{len(d['waiting_rechecks'])} generation lists to review")
    if d["rel"].get("provisional"):
        todo.append(f"{d['rel'].get('provisional')} relations to review")
    if d["errors"]:
        todo.append(f"{len(d['errors'])} cars with an error")
    if todo:
        lines.append("Left for you: " + ", ".join(todo) + ".")
    return {"outcome": outcome, "pill": pill, "lines": lines, "stoppedAt": b.astimezone() if b else None}


# ---------------------------------------------------------------- gathering
def gather():
    now = dt.datetime.now(dt.timezone.utc)
    store_path = os.path.join(REPO, "app", "llm_families.json")
    s = read_json(store_path)
    cars = read_json(os.path.join(REPO, "app", "cars.json"))
    nodes = {n["id"]: n for n in cars["nodes"]}
    harvested = {n["id"] for n in cars["nodes"] if n["type"] in ("model", "family")}
    make_slugs = {slug(n["label"]) for n in cars["nodes"] if n["type"] == "make"}
    model_slugs = {slug(n["label"]) for n in cars["nodes"] if n["type"] in ("model", "family")}

    def label(i):
        n = nodes.get(i)
        if n:
            return ((n.get("make") or "") + " " + n.get("label", "")).strip()
        t = re.sub(r"^(llm-related-|llm-m-|llm-fam-|llm-)", "", i).replace("-", " ")
        return t[:1].upper() + t[1:]

    fam = s.get("families") or {}
    rel = s.get("relations") or {}
    rc = s.get("recheck") or {}
    pc = s.get("pendingCascade") or {}
    fs = s.get("fullScan") or {}
    done = list((fs.get("done") or {}).keys())
    es = s.get("engineScans") or {}

    procs = {name: bool(sh("pgrep", "-f", pat)) for name, pat in
             (("agent", "llm_agent.py"), ("server", "serve.py"), ("model", "llama-server"))}
    if AGENT["pid"]:
        procs["agent"] = not AGENT["final"]
    store_age = time.time() - os.path.getmtime(store_path)
    log_path = os.path.join(REPO, "llama_logs", "llama-server-8080.log")
    model_age = time.time() - os.path.getmtime(log_path) if os.path.exists(log_path) else None

    if not procs["agent"]:
        state = ("stopped", "Agent stopped")
    elif store_age > 20 * 60 and (model_age is None or model_age > 5 * 60):
        state = ("stalled", "Nothing written for %d min" % (store_age // 60))
    else:
        state = ("running", "Running")

    # activity: checks per local hour, last 12 hours
    local = dt.datetime.now().astimezone()
    hours = [(local - dt.timedelta(hours=h)).replace(minute=0, second=0, microsecond=0) for h in range(11, -1, -1)]
    per_hour = Counter()
    for e in fam.values():
        t = parse_time(e.get("checkedAt"))
        if t:
            per_hour[t.astimezone().replace(minute=0, second=0, microsecond=0)] += 1
    activity = [(h.strftime("%H"), per_hour.get(h, 0)) for h in hours]

    os.makedirs(OUT_DIR, exist_ok=True)
    queue = read_queue()
    qlist = (queue or {}).get("queue") or []
    finished = track_requests(queue, fs, len(done), len(pc), now)
    cur = getattr(track_requests, "current", None)
    req_id = cur["id"] if cur else fs.get("seed")
    started = parse_time(cur.get("startedAt")) if cur else parse_time(fs.get("startedAt"))
    elapsed = (now - started).total_seconds() if started else None
    baseline = (cur or {}).get("baseline") or 0

    # history: one line per run of this script, for a pace measured between runs
    snap = {"t": now.timestamp(), "seed": fs.get("seed"), "req": req_id, "done": len(done), "queued": len(pc), "checks": len(fam)}
    hist = []
    if os.path.exists(HISTORY):
        for line in open(HISTORY, encoding="utf-8"):
            try:
                hist.append(json.loads(line))
            except ValueError:
                pass
    hist = [h for h in hist if h.get("req") == snap["req"] and h.get("done", 0) <= snap["done"]]
    # What moved since the page was last written (the newest earlier snapshot
    # that is at least five minutes old, so two quick runs do not read "+0").
    prev = next((h for h in reversed(hist) if snap["t"] - h["t"] >= 300), None)
    delta = None
    if prev and snap["t"] - prev["t"] <= 6 * 3600:
        delta = {"done": snap["done"] - prev["done"], "queued": snap["queued"] - prev["queued"],
                 "since": dt.datetime.fromtimestamp(prev["t"]).astimezone()}
    if not hist or snap["t"] - hist[-1]["t"] > 120:
        hist.append(snap)
    with open(HISTORY, "w", encoding="utf-8") as f:
        for h in hist[-400:]:
            f.write(json.dumps(h) + "\n")

    pace = None
    older = [h for h in hist if 15 * 60 <= snap["t"] - h["t"] <= 3 * 3600]
    if older:
        ref = older[0]
        hrs = (snap["t"] - ref["t"]) / 3600
        pace = (snap["done"] - ref["done"]) / hrs if hrs > 0 else None
        pace_basis = "last %.1f h" % hrs
        growth = (snap["queued"] - ref["queued"]) / hrs if hrs > 0 else 0
    elif elapsed and elapsed > 600:
        pace = (len(done) - baseline) / (elapsed / 3600)
        pace_basis = "average since start"
        growth = None
    else:
        pace_basis, growth = "", None
    eta_hours = (len(pc) / pace) if pace and pace > 0 else None
    eta_at = local + dt.timedelta(hours=eta_hours) if eta_hours is not None else None

    # the last thing the scan wrote: the newest check, or the store itself
    stamps = [parse_time(e.get("checkedAt")) for bucket in (fam, rc, es) for e in bucket.values()]
    stamps = [t for t in stamps if t]
    last_check = max(stamps).astimezone() if stamps else None
    wrote = dt.datetime.fromtimestamp(os.path.getmtime(store_path)).astimezone()
    last_activity = max(x for x in (last_check, wrote) if x)

    batt = sh("pmset", "-g", "batt")
    on_battery = "Battery Power" in batt.splitlines()[0] if batt else False
    pct = re.search(r"(\d+)%", batt)
    power = ("on battery" + (f" ({pct.group(1)}%)" if pct else "")) if on_battery else ("on mains power" if batt else "")

    # makes the scan created that the harvest does not have
    placeholder_ids = sorted({k for k in list((s.get("mintedFacts") or {})) + list(fam) + list(s.get("wpLinks") or {})
                              if k.startswith("llm-related-")})
    created = Counter()
    for k in placeholder_ids:
        body = k[len("llm-related-"):]
        if any(body.startswith(m + "-") for m in make_slugs):
            continue
        first = body.split("-")[0]
        if re.fullmatch(r"\d{4}", first):
            continue          # "1957 Ford": led by a year, filed under the real make
        created[first] += 1
    suspect = {m for m in created
               if re.search(r"\d", m) or m in model_slugs or any(x.startswith(m + "-") for x in model_slugs)}

    errors = [(label(k), (e.get("error") or "").split(" (")[0][:110])
              for k, e in fam.items() if e.get("status") == "error"]
    errors += [(label(k) + " (re-check)", (e.get("error") or "")[:110]) for k, e in rc.items() if e.get("status") == "error"]
    guard = [(label(k), e.get("sourceTitle") or "") for k, e in fam.items() if (e.get("proposal") or {}).get("notACar")]
    outsiders = [(label(k), ", ".join(o.get("code", "") for o in e["outsiders"]))
                 for b in (fam, rc) for k, e in b.items() if e.get("outsiders")]
    waiting_rechecks = [label(k) for k, e in rc.items() if e.get("status") == "provisional"]

    git_line = sh("git", "-C", REPO, "status", "-sb").splitlines()[:1]
    ahead = re.search(r"ahead (\d+)", git_line[0]) if git_line else None
    last_commit = sh("git", "-C", REPO, "log", "-1", "--format=%s|%cr")

    return {
        "now": local, "state": state, "procs": procs, "store_age": store_age,
        "seed": (cur or {}).get("label") or (label(fs["seed"]) if fs.get("seed") else None), "elapsed": elapsed,
        "carried": (cur or {}).get("carriedFrom"), "baseline": baseline,
        "done": max(0, len(done) - baseline), "queued": len(pc), "checks": len(fam),
        "reached": len((set(done) | set(fam)) & harvested), "harvest": len(harvested),
        "new_cars": len(placeholder_ids),
        "depth": sorted(Counter(v.get("depth") for v in pc.values() if v.get("depth") is not None).items()),
        "pace": pace, "pace_basis": pace_basis, "growth": growth, "eta": eta_hours,
        "activity": activity,
        "fam": Counter(e.get("status") for e in fam.values()),
        "rel": Counter(e.get("status") for e in rel.values()), "rejected": len(s.get("rejectedRelations") or {}),
        "rc": Counter(e.get("status") for e in rc.values()), "waiting_rechecks": waiting_rechecks,
        "generations": sum(len((e.get("proposal") or {}).get("generations") or []) for e in fam.values()
                           if e.get("status") == "confirmed"),
        "eng_lists": len(es), "eng_with": sum(1 for e in es.values() if e.get("engines") or e.get("unlinked")),
        "eng_merges": len(s.get("engineMerges") or {}), "eng_read": len(s.get("engines") or {}),
        "errors": errors, "guard": guard, "outsiders": outsiders,
        "created": created.most_common(), "suspect": suspect,
        "latest": [label(i) for i in done[-8:]][::-1],
        "queue": [(j.get("targetLabel") or j.get("targetId") or "?", j.get("state") or "") for j in qlist],
        "queue_ok": queue is not None,
        "store_mb": os.path.getsize(store_path) / 1e6,
        "unpushed": bool(sh("git", "-C", REPO, "status", "--short", "app/llm_families.json")),
        "ahead": int(ahead.group(1)) if ahead else 0, "last_commit": last_commit,
        "history": hist, "delta": delta, "eta_at": eta_at, "last_activity": last_activity,
        "power": power, "on_battery": on_battery, "finished": finished,
        "run": getattr(track_requests, "run", {}),
    }


# ---------------------------------------------------------------- rendering
def n(x):
    return f"{x:,}"


def dur(seconds):
    if seconds is None:
        return "unknown"
    h, m = int(seconds // 3600), int(seconds % 3600 // 60)
    return f"{h} h {m:02d} m" if h else f"{m} m"


def clock(t, ref):
    """A time for a reader hours later: 00:30, or Wed 00:30 on another day."""
    if not t:
        return "–"
    return t.strftime("%H:%M") if t.date() == ref.date() else t.strftime("%a %H:%M")


def stacked(parts):
    """parts: [(label, value, css class)] -> a stacked bar and its legend."""
    total = sum(v for _, v, _ in parts) or 1
    bar = "".join(f'<i class="{c}" style="flex:{v}"></i>' for _, v, c in parts if v)
    legend = "".join(f'<span><b class="dot {c}"></b>{html.escape(l)} <em>{n(v)}</em></span>' for l, v, c in parts)
    return f'<div class="stack">{bar}</div><div class="legend">{legend}</div>', total


def nice_top(v):
    """A round number at or above v for the top of an axis, so the ticks read
    0 / 75 / 150 and not 0 / 65.5 / 131. The top and its half are both whole."""
    if v <= 0:
        return 2
    mag = 10 ** (len(str(int(v))) - 1)
    for m in (1, 1.2, 1.5, 2, 3, 4, 5, 6, 8, 10):
        top = m * mag
        if v <= top and top == int(top) and int(top) % 2 == 0:
            return int(top)
    return 10 * mag


def trend_chart(history, baseline):
    """Cars finished and cars waiting over the life of this request: two
    lines on one axis (both count cars), with the axis numbered, the time
    span labelled, and each line's last value written at its end."""
    pts = [dict(p, done=max(0, p["done"] - baseline)) for p in history[-200:]]
    if len(pts) < 2:
        return "<div class='muted' style='font-size:13px;margin-top:12px'>The trend appears after two updates.</div>"
    t0, t1 = pts[0]["t"], pts[-1]["t"]
    top = nice_top(max(max(p["done"], p["queued"]) for p in pts))
    H = 132
    x = lambda p: (p["t"] - t0) / max(t1 - t0, 1) * 100
    y = lambda v: 100 - v / top * 100

    def line(key, cls):
        d_ = " ".join(f'{"M" if i == 0 else "L"}{x(p):.2f},{y(p[key]):.2f}' for i, p in enumerate(pts))
        return f'<path d="{d_}" class="{cls}"/>'
    ticks = "".join(f"<i class='grid' style='top:{y(v):.1f}%'></i><span class='tick' style='top:{y(v):.1f}%'>{n(int(v))}</span>" for v in (0, top / 2, top))
    last = pts[-1]
    # the higher line's label sits above its end, the lower one's below, so they never meet
    hi = "done" if last["done"] >= last["queued"] else "queued"
    ends = ""
    for key, cls, name in (("done", "s1", "finished"), ("queued", "s2", "waiting")):
        yy = y(last[key])
        above = (key == hi and yy > 14) or yy > 86
        ends += (f"<b class='end {cls}' style='top:{yy:.1f}%'></b>"
                 f"<span class='endlabel' style='top:{yy:.1f}%;margin-top:{-22 if above else 8}px'>{n(last[key])} {name}</span>")
    hits = "".join(f"<u style='left:{x(p):.2f}%' title='{dt.datetime.fromtimestamp(p['t']).strftime('%H:%M')}: "
                   f"{p['done']:,} finished, {p['queued']:,} waiting'></u>" for p in pts)
    mid = dt.datetime.fromtimestamp((t0 + t1) / 2).strftime("%H:%M")
    rows = "".join(f"<tr><td>{dt.datetime.fromtimestamp(p['t']).strftime('%a %H:%M')}</td><td>{p['done']:,}</td><td>{p['queued']:,}</td></tr>"
                   for p in pts[-12:][::-1])
    return ("<div class='chart-title'>Cars finished and waiting over this request</div>"
            f"<div class='chart'><div class='plot' style='height:{H}px'>{ticks}"
            f"<svg viewBox='0 0 100 100' preserveAspectRatio='none' role='img' aria-label='Cars finished and cars waiting over time'>"
            f"{line('queued', 'l2')}{line('done', 'l1')}</svg>{hits}{ends}</div>"
            f"<div class='xaxis'><span>{dt.datetime.fromtimestamp(t0).strftime('%H:%M')}</span><span>{mid}</span>"
            f"<span>{dt.datetime.fromtimestamp(t1).strftime('%H:%M')}</span></div></div>"
            "<div class='legend'><span><b class='key s1'></b>finished</span><span><b class='key s2'></b>waiting</span>"
            "<span class='muted'>number of cars</span></div>"
            f"<details class='tbl'><summary>Show as table</summary><table><tr><th>Time</th><th>Finished</th><th>Waiting</th></tr>{rows}</table></details>")


def hour_chart(activity):
    """Checks per clock hour. Every column's height is set in pixels from one
    scale that starts at zero, so 73 is drawn at just over half of 131."""
    top = nice_top(max(v for _, v in activity))
    H = 104
    peak = max(range(len(activity)), key=lambda i: activity[i][1])
    cols = ""
    for i, (h, v) in enumerate(activity):
        now_ = i == len(activity) - 1
        lab = (f"<em>{v}</em>" if (i == peak or now_) and v else "")
        cols += (f"<div title='{h}:00 to {h}:59 -- {v} checks'>{lab}"
                 f"<i class='{'part' if now_ else ''}' style='height:{max(v / top * H, 1 if v else 0):.1f}px'></i></div>")
    ticks = "".join(f"<i class='grid' style='bottom:{v / top * H:.1f}px'></i><span class='tick' style='bottom:{v / top * H:.1f}px'>{n(int(v))}</span>" for v in (0, top / 2, top))
    hours = "".join(f"<span>{h}</span>" for h, _ in activity)
    rows = "".join(f"<tr><td>{h}:00</td><td>{v}</td></tr>" for h, v in activity[::-1])
    return (f"<div class='chart'><div class='plot bars' style='height:{H + 18}px'>{ticks}<div class='cols'>{cols}</div></div>"
            f"<div class='xaxis hours'>{hours}</div></div>"
            "<div class='legend'><span class='muted'>Hour of the day. The last column is the current hour, so far.</span></div>"
            f"<details class='tbl'><summary>Show as table</summary><table><tr><th>Hour</th><th>Checks</th></tr>{rows}</table></details>")


CSS = """
:root{--bg:#f6f5f1;--card:#fff;--ink:#1c1b19;--muted:#6f6b63;--line:#e4e1d9;--accent:#0f766e;--accent2:#b45309;
--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--c1:#2a78d6;--c2:#eb6834;--c3:#d6d3cb;--c4:#b91c1c;--c5:#b45309;
--s1:#2a78d6;--s2:#eb6834;--grid:#eceae3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1d1b;--ink:#eceae4;--muted:#9a968d;--line:#2e2c29;
--accent:#2dd4bf;--accent2:#fbbf24;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--c1:#3987e5;--c2:#d95926;--c3:#3a3835;--c4:#f87171;--c5:#fbbf24;
--s1:#3987e5;--s2:#d95926;--grid:#2a2826}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:780px;margin:0 auto;padding:20px 16px 40px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
h1{font-size:21px;margin:0;letter-spacing:-.01em}.sub{color:var(--muted);font-size:13px;margin-top:2px}
.pill{font-size:12px;font-weight:600;padding:5px 11px;border-radius:999px;white-space:nowrap;border:1px solid currentColor}
.running{color:var(--ok)}.stalled{color:var(--warn)}.stopped{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-top:12px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px;font-weight:600}
.now b{font-size:18px}.now .next{color:var(--muted);font-size:13px;margin-top:2px}
.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}
@media(min-width:620px){.kpis{grid-template-columns:repeat(4,1fr)}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.kpi .v{font-size:26px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .l{font-size:12px;color:var(--muted)}.kpi .d{font-size:12px;color:var(--muted);margin-top:2px}
.stack{display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--c3);gap:2px}
.stack i{display:block;min-width:3px}.c-done,.c1{background:var(--c1)}.c-wait,.c2{background:var(--c2)}
.c3{background:var(--c3)}.c4{background:var(--c4)}.c5{background:var(--c5)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--muted);margin-top:7px}
.legend em{font-style:normal;color:var(--ink);font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
.row{display:grid;grid-template-columns:54px 1fr 44px;align-items:center;gap:10px;font-size:13px;margin:5px 0}
.row .bar{height:9px;border-radius:5px;background:var(--c3);overflow:hidden}.row .bar i{display:block;height:100%;background:var(--c1)}
.row .num{text-align:right;font-variant-numeric:tabular-nums}.row.limit .bar i{background:var(--c2)}
.chart-title{font-size:13px;font-weight:600;margin:16px 0 8px}
.chart{padding-left:38px}.plot{position:relative;margin-right:6px}
.plot .grid{position:absolute;left:0;right:0;height:1px;background:var(--grid)}
.plot .tick{position:absolute;left:-38px;width:32px;text-align:right;font-size:11px;color:var(--muted);transform:translateY(-50%);font-variant-numeric:tabular-nums}
.plot.bars .tick{transform:translateY(50%)}
.plot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.plot svg path{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.l1{stroke:var(--s1)}.l2{stroke:var(--s2)}
.plot u{position:absolute;top:0;bottom:0;width:14px;margin-left:-7px;text-decoration:none}
.plot .end{position:absolute;right:-5px;width:10px;height:10px;margin-top:-5px;border-radius:50%;box-shadow:0 0 0 2px var(--card)}
.s1{background:var(--s1)}.s2{background:var(--s2)}
.plot .endlabel{position:absolute;right:12px;font-size:12px;font-weight:600;color:var(--ink);white-space:nowrap;line-height:14px;background:var(--card);padding:0 4px;border-radius:3px}
.key{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.xaxis{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin:5px 6px 0 0;font-variant-numeric:tabular-nums}
.xaxis.hours span{flex:1;text-align:center}
.cols{position:absolute;left:0;right:0;bottom:0;top:0;display:flex;align-items:flex-end;gap:2px}
.cols div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:0}
.cols i{display:block;flex:none;width:100%;max-width:24px;background:var(--s1);border-radius:4px 4px 0 0}
.cols i.part{opacity:.45}.cols em{flex:none;font-size:11px;font-weight:600;font-style:normal;color:var(--ink);line-height:15px}
details.tbl summary{font-size:12px}details.tbl table{border-collapse:collapse;font-size:12px;margin-top:6px;font-variant-numeric:tabular-nums}
details.tbl td,details.tbl th{padding:3px 14px 3px 0;text-align:left;border-top:1px solid var(--line)}details.tbl th{color:var(--muted);font-weight:500;border-top:0}
ol.q{list-style:none;margin:0;padding:0;counter-reset:q}ol.q li{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--line);counter-increment:q}
ol.q li:first-child{border-top:0}ol.q li::before{content:counter(q);color:var(--muted);width:18px;font-variant-numeric:tabular-nums}
ol.q li span{flex:1}.chip{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.chip.on{color:var(--ok);border-color:currentColor}.chip.flag{color:var(--warn);border-color:currentColor}
.block{margin-top:14px}.block:first-of-type{margin-top:0}.block .t{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}
.block .t b{font-weight:600}.block .t span{color:var(--muted);font-variant-numeric:tabular-nums}
ul.plain{list-style:none;margin:0;padding:0;font-size:13px}ul.plain li{padding:5px 0;border-top:1px solid var(--line)}
ul.plain li:first-child{border-top:0}ul.plain small{display:block;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px}.muted{color:var(--muted)}
details summary{cursor:pointer;font-size:13px;color:var(--muted);margin-top:8px}
.final{border-width:2px}.final p{margin:0 0 7px}.final p:last-child{margin:0}.final p:first-of-type{font-weight:600;font-size:16px}
.final.completed{border-color:var(--ok)}.final.completed h2{color:var(--ok)}
.final.stopped,.final.interrupted{border-color:var(--warn)}.final.stopped h2,.final.interrupted h2{color:var(--warn)}
.alert{border-color:var(--bad)}.alert h2{color:var(--bad)}.now .next.warn{color:var(--warn)}
details.fold>summary{list-style:none;cursor:pointer;margin:0;display:flex;justify-content:space-between;align-items:center}
details.fold>summary::-webkit-details-marker{display:none}details.fold>summary h2{margin:0}
details.fold>summary::after{content:"Show";font-size:12px;color:var(--muted)}details.fold[open]>summary::after{content:"Hide"}
details.fold[open]>summary{margin-bottom:12px}ul.plain li em.chip{font-style:normal;margin-left:6px}
footer{color:var(--muted);font-size:12px;margin-top:16px;line-height:1.6}
"""


def render(d):
    e = html.escape
    state, state_text = d["state"]
    nxt = [q for q, st in d["queue"] if st != "running"]
    running = [q for q, st in d["queue"] if st == "running"]
    current = d["seed"] or (running[0] if running else None)

    out = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'>"
           f"<meta name='viewport' content='width=device-width,initial-scale=1'><title>CarWeb scan status</title>"
           f"<style>{CSS}</style></head><body><main>"]
    final = final_report(d) if state == "stopped" else None
    pill = state
    if final:
        state_text = final["pill"]
        pill = "running" if final["outcome"] == "completed" else "stalled"
    nxt_at = d.get("next_refresh")
    out.append(f"<header><div><h1>CarWeb scan</h1><div class='sub'>Updated {d['now'].strftime('%H:%M, %a %d %b')}"
               f"<span id='ago'></span>"
               + (f" · running for {dur(d['elapsed'])}" if d["elapsed"] and not final else "") + "</div>"
               + (f"<div class='sub'>Next update about {nxt_at.strftime('%H:%M')}</div>" if nxt_at else
                  "<div class='sub'>Updates resume when the agent starts again</div>" if final else "")
               + f"</div><div class='pill {pill}'>{e(state_text)}</div></header>")

    down = [k for k, v in d["procs"].items() if not v]
    if final:
        out.append("<div class='card final " + final["outcome"] + "'><h2>Final report</h2>"
                   + "".join(f"<p>{e(x)}</p>" for x in final["lines"]) + "</div>")
    elif down and state != "running":
        out.append(f"<div class='card alert'><h2>Attention</h2>Not running: {e(', '.join(down))}. "
                   f"Store last written {dur(d['store_age'])} ago.</div>")

    if d["on_battery"]:
        out.append(f"<div class='card alert'><h2>Attention</h2>The Mac is {e(d['power'])}. "
                   "On battery it can sleep, and the run pauses until it wakes.</div>")

    la = d["last_activity"]
    quiet = (d["now"] - la).total_seconds() if la else None
    act = ""
    if la:
        act = (f"<div class='next{' warn' if quiet and quiet > 600 and state != 'stopped' else ''}'>Last activity {clock(la, d['now'])}"
               + (f" · {dur(quiet)} before this update" if quiet and quiet >= 120 else "") + "</div>")
    done_at = clock(d["eta_at"], d["now"]) if d["eta_at"] and state == "running" else None
    out.append(f"<div class='card now'><h2>{'Last scanned' if final else 'Now scanning'}</h2>"
               f"<b>{e(current or 'Nothing')}</b>" + act
               + (f"<div class='next'>Also finishing the cars left over from {e(d['carried'])}</div>" if d.get("carried") else "")
               + (f"<div class='next'>Next: {e(nxt[0])}" + (f" · starts around {done_at}" if done_at else "")
                  + (f" · then {len(nxt) - 1} more" if len(nxt) > 1 else "") + "</div>" if nxt else "")
               + "</div>")

    pace = f"{d['pace']:.0f}" if d["pace"] else "–"
    cover = 100 * d["reached"] / d["harvest"] if d["harvest"] else 0
    eta = clock(d["eta_at"], d["now"]) if d["eta_at"] else "–"
    left = ("about " + (f"{d['eta']:.0f} h" if d["eta"] >= 1 else f"{d['eta'] * 60:.0f} min") + " at this pace") if d["eta"] else "&nbsp;"
    dl = d["delta"]
    d_done = (f"{dl['done']:+,} since {dl['since'].strftime('%H:%M')}" if dl else f"{n(d['checks'])} checks on file")
    d_wait = (f"{dl['queued']:+,} since {dl['since'].strftime('%H:%M')}" if dl else "")
    grow = ""
    if d["growth"] is not None:
        grow = ("queue growing %+.0f/h" % d["growth"]) if d["growth"] > 1 else ("queue shrinking %+.0f/h" % d["growth"]) if d["growth"] < -1 else "queue level"
    out.append("<div class='kpis'>"
               f"<div class='kpi'><div class='l'>Cars finished</div><div class='v'>{n(d['done'])}</div><div class='d'>{e(d_done)}</div></div>"
               f"<div class='kpi'><div class='l'>Waiting</div><div class='v'>{n(d['queued'])}</div><div class='d'>{e(d_wait or grow) or '&nbsp;'}</div></div>"
               + (f"<div class='kpi'><div class='l'>Requests finished</div><div class='v'>{len([r for r in d['finished'] if r['state'] == 'done'])}</div><div class='d'>in this run</div></div>"
                  f"<div class='kpi'><div class='l'>Stopped at</div><div class='v'>{clock(final['stoppedAt'], d['now'])}</div><div class='d'>&nbsp;</div></div>"
                  if final else
                  f"<div class='kpi'><div class='l'>Pace</div><div class='v'>{pace}<small style='font-size:13px;font-weight:500'> /h</small></div><div class='d'>{e(d['pace_basis'])}</div></div>"
                  f"<div class='kpi'><div class='l'>Done around</div><div class='v'>{eta}</div><div class='d'>{left}</div></div>")
               + "</div>")

    bar, _ = stacked([("finished", d["done"], "c-done"), ("waiting", d["queued"], "c-wait")])
    out.append(f"<div class='card'><h2>This request</h2>{bar}{trend_chart(d['history'], d['baseline'])}"
               f"<div class='legend' style='margin-top:10px'><span>Graph reached <em>{n(d['reached'])}</em> of {n(d['harvest'])} harvested cars ({cover:.0f}%)</span>"
               f"<span>New cars created <em>{n(d['new_cars'])}</em></span></div></div>")

    if d["depth"]:
        top = max(v for _, v in d["depth"]) or 1
        deepest = max(k for k, _ in d["depth"])
        rows = "".join(f"<div class='row{' limit' if k == deepest and k >= 7 else ''}'><div>{k} hop{'' if str(k) == '1' else 's'}</div>"
                       f"<div class='bar'><i style='width:{100 * v / top:.0f}%'></i></div><div class='num'>{n(v)}</div></div>"
                       for k, v in d["depth"])
        out.append(f"<div class='card'><h2>Waiting, by distance from the seed</h2>{rows}"
                   "<div class='legend'><span>Cars at the depth limit are read but add nothing new.</span></div></div>")

    out.append(f"<div class='card'><h2>Checks per hour, last 12 hours</h2>{hour_chart(d['activity'])}</div>")

    if d["queue_ok"]:
        items = "".join(f"<li><span>{e(q)}</span><em class='chip{' on' if st == 'running' else ''}'>{e(st)}</em></li>" for q, st in d["queue"])
        out.append(f"<div class='card'><h2>Request queue</h2><ol class='q'>{items or '<li><span>Empty</span></li>'}</ol></div>")
    else:
        out.append("<div class='card'><h2>Request queue</h2><span class='muted'>Could not reach the queue service.</span></div>")

    f, r, rc = d["fam"], d["rel"], d["rc"]
    b1, t1 = stacked([("split", f.get("confirmed", 0), "c1"), ("deferred", f.get("same-article", 0), "c2"),
                      ("single generation", f.get("none", 0), "c3"), ("error", f.get("error", 0), "c4")])
    b2, t2 = stacked([("confirmed", r.get("confirmed", 0), "c1"), ("waiting", r.get("provisional", 0), "c5"),
                      ("rejected", d["rejected"], "c3")])
    b3, t3 = stacked([("with engines", d["eng_with"], "c1"), ("none found", d["eng_lists"] - d["eng_with"], "c3")])
    out.append("<div class='card'><h2>What it has found</h2>"
               f"<div class='block'><div class='t'><b>Cars checked</b><span>{n(t1)} · {n(d['generations'])} generations created</span></div>{b1}</div>"
               f"<div class='block'><div class='t'><b>Relations</b><span>{n(t2)}</span></div>{b2}</div>"
               f"<div class='block'><div class='t'><b>Engine lists</b><span>{n(t3)} · {n(d['eng_merges'])} merges</span></div>{b3}</div></div>")

    wr = d["waiting_rechecks"]
    if wr or r.get("provisional"):
        names = ", ".join(e(x) for x in wr[:12]) + (f" and {len(wr) - 12} more" if len(wr) > 12 else "")
        out.append("<div class='card'><h2>Waiting for you</h2><ul class='plain'>"
                   + (f"<li><b>{len(wr)}</b> generation lists to review in Pending Generation Splits<small>{names}</small></li>" if wr else "")
                   + (f"<li><b>{r.get('provisional', 0)}</b> relations waiting for review</li>" if r.get("provisional") else "")
                   + "</ul></div>")

    if d["errors"]:
        items = "".join(f"<li>{e(a)}<small>{e(b)}</small></li>" for a, b in d["errors"])
        out.append(f"<div class='card'><h2>Errors ({len(d['errors'])})</h2><ul class='plain'>{items}</ul></div>")

    fin = d["finished"]
    if fin:
        rows = "".join(
            f"<li>{e(r['label'])} <em class='chip{' on' if r['state'] == 'done' else ' flag'}'>{e(r['state'])}</em>"
            f"<small>{'took ' + dur(r['took']) + ' · ' if r['took'] else ''}finished {clock(r['at'], d['now'])}"
            + (f" · {n(r['cars'])} cars" if r.get('cars') else "")
            + (" · pushed to GitHub" if r["pushed"] else " · not pushed") + "</small>"
            + (f"<small>{e(r['reason'])}</small>" if r.get("reason") and r["state"] != "done" else "") + "</li>" for r in fin)
        out.append(f"<div class='card'><h2>Finished requests</h2><ul class='plain'>{rows}</ul></div>")
    else:
        out.append("<div class='card'><h2>Finished requests</h2><span class='muted'>None yet. Results are pushed to GitHub "
                   "when a request finishes" + (f", so the first push comes with {e(current)}." if current else ".") + "</span></div>")

    chips = "".join(f"<span class='chip{' flag' if m in d['suspect'] else ''}' title='{c} car(s)'>{e(m)} · {c}</span>" for m, c in d["created"])
    guard = "".join(f"<li>{e(a)}<small>linked to “{e(b)}”</small></li>" for a, b in d["guard"])
    outs = "".join(f"<li>{e(a)}<small>set aside: {e(b)}</small></li>" for a, b in d["outsiders"])
    latest = ("<div class='block'><div class='t'><b>Latest finished cars</b><span></span></div><ul class='plain'>"
              + "".join(f"<li>{e(x)}</li>" for x in d["latest"]) + "</ul></div>") if d["latest"] else ""
    out.append("<details class='card fold'><summary><h2>Details</h2></summary>" + latest +
               f"<div class='block'><div class='t'><b>Makes the scan created</b><span>{len(d['created'])}</span></div>"
               f"<div class='chips'>{chips or '<span class=muted>None</span>'}</div>"
               "<div class='legend'><span><b class='dot c5'></b>shares its name with a model or is a code: check it</span></div></div>"
               f"<div class='block'><div class='t'><b>Maker pages not split</b><span>{len(d['guard'])}</span></div>"
               + (f"<details><summary>Show</summary><ul class='plain'>{guard}</ul></details>" if guard else "") + "</div>"
               f"<div class='block'><div class='t'><b>Predecessors and successors set aside</b><span>{len(d['outsiders'])}</span></div>"
               + (f"<ul class='plain'>{outs}</ul>" if outs else "") + "</div></details>")

    procs = " · ".join(f"{k} {'up' if v else 'DOWN'}" for k, v in d["procs"].items())
    push = "local results not pushed yet" if d["unpushed"] else "store matches the last commit"
    out.append(f"<footer>{e(procs)}" + (f" · {e(d['power'])}" if d["power"] else "")
               + f" · store {d['store_mb']:.1f} MB<br>"
               f"{e(push)}" + (f" · {d['ahead']} commit(s) ahead of origin" if d["ahead"] else "")
               + f" · last commit: {e(d['last_commit'].replace('|', ', '))}</footer>")
    # Where the viewer runs scripts, say how old the page is. Where it does
    # not (a file preview on a phone), the written time above still stands.
    out.append("<script>try{var m=Math.round((Date.now()-%d)/60000);if(m>=2)document.getElementById('ago')"
               ".textContent=' ('+(m<90?m+' min ago':Math.round(m/60)+' h ago')+')';}catch(e){}</script>"
               % int(d["now"].timestamp() * 1000))
    out.append("</main></body></html>")
    return "".join(out)


def summary(d):
    state, text = d["state"]
    nxt = [q for q, st in d["queue"] if st != "running"]
    lines = [
        f"{text} · {d['now'].strftime('%H:%M')} · {d['seed'] or 'no request'}" + (f" · {dur(d['elapsed'])} in" if d["elapsed"] else ""),
        f"finished {n(d['done'])} · waiting {n(d['queued'])} · pace {d['pace']:.0f}/h ({d['pace_basis']})" if d["pace"] else f"finished {n(d['done'])} · waiting {n(d['queued'])}",
        f"next: {nxt[0] if nxt else 'nothing queued'}" + (f" (+{len(nxt) - 1})" if len(nxt) > 1 else ""),
        f"errors {len(d['errors'])} · to review {len(d['waiting_rechecks'])} lists, {d['rel'].get('provisional', 0)} relations",
        f"dashboard: {OUT}",
    ]
    return "\n".join(lines)


def write_page(next_refresh=None):
    data = gather()
    data["next_refresh"] = next_refresh if data["state"][0] != "stopped" else None
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(render(data))
    os.replace(tmp, OUT)          # never a half-written page in the synced folder
    # The last page of a run is also kept under its own name: the live page
    # is overwritten the next time the agent starts, and this is not.
    run = data.get("run") or {}
    if data["state"][0] == "stopped" and run.get("stoppedAt") and not run.get("reported"):
        stopped = parse_time(run["stoppedAt"]) or dt.datetime.now().astimezone()
        copy = os.path.join(OUT_DIR, "CarWeb final report " + stopped.astimezone().strftime("%Y-%m-%d %H%M") + ".html")
        try:
            with open(copy, "w", encoding="utf-8") as fh:
                fh.write(open(OUT, encoding="utf-8").read())
            log_ = json.load(open(REQUESTS, encoding="utf-8"))
            log_.setdefault("run", {})["reported"] = True
            json.dump(log_, open(REQUESTS, "w", encoding="utf-8"))
            data["final_copy"] = copy
        except (OSError, ValueError):
            pass
    return data


def log(msg):
    print(dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S") + "  " + msg, flush=True)


# ------------------------------------------------------------ in the agent --
_thread = None
_stop = None


def start(out, interval_min=INTERVAL_MIN, say=log):
    """Write the page now and every `interval_min` minutes until final()."""
    import threading
    global _thread, _stop
    configure(out)
    AGENT.update({"pid": str(os.getpid()), "final": False})
    _stop = threading.Event()
    step = max(1.0, interval_min) * 60

    def loop():
        while not _stop.is_set():
            try:
                write_page(dt.datetime.now().astimezone() + dt.timedelta(seconds=step))
            except Exception as ex:            # tried again at the next refresh
                say(f"status page: could not write it ({str(ex)[:120]})")
            _stop.wait(step)

    _thread = threading.Thread(target=loop, name="status-page", daemon=True)
    _thread.start()
    say(f"status page: {OUT} (every {interval_min:g} min)")


def refresh():
    """Write the page now, outside its schedule (a request just started or finished)."""
    if OUT and not AGENT["final"]:
        try:
            write_page()
        except Exception:
            pass


def job_started(job):
    if job:
        AGENT["job"] = {"id": job.get("id"), "targetId": job.get("targetId"),
                        "targetLabel": job.get("targetLabel") or job.get("targetId")}
        refresh()


def job_finished(jid, state, summary):
    if jid:
        job = AGENT["job"] or {}
        AGENT["last"] = {"id": jid, "state": "done" if state == "done" else "failed",
                         "finishedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "summary": summary or "",
                         "targetLabel": job.get("targetLabel") if job.get("id") == jid else None}
        AGENT["job"] = None
        refresh()


def final():
    """The last write of a run: the page marked stopped, and kept as a dated report."""
    if not OUT or AGENT["final"]:
        return None
    if _stop:
        _stop.set()
    AGENT["final"] = True
    try:
        return write_page()
    except Exception as ex:
        log(f"status page: could not write the final report ({str(ex)[:120]})")
        return None


def main():
    ap = argparse.ArgumentParser(description="Write the CarWeb scan status page once.")
    ap.add_argument("--out", default=configured_path(), help="where to write the page")
    ap.add_argument("--repo", default=REPO, help="the CarWeb repository")
    args = ap.parse_args()
    if not args.out:
        sys.exit("no --out given, and no statusPage in " + SETTINGS)
    configure(args.out, args.repo)
    print(summary(write_page()))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as ex:  # a clear line beats a traceback
        sys.exit(f"could not read the scan state: {ex}")
