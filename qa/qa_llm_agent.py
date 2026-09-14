#!/usr/bin/env python3
"""Unit checks for scripts/llm_agent.py's decision-making.

Everything the agent does that is worth getting wrong happens before a single
model call: WHICH nodes it picks, in WHAT order, and WHICH files it is allowed
to commit. Those are pure functions over a text report and a JSON file, so
they are tested here with fixtures -- no llama-server, no browser, no network,
which is also why this suite (unlike the other qa_*.py files) runs anywhere.
"""
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("llm_agent", os.path.join(ROOT, "scripts", "llm_agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (("  -- " + str(extra)) if extra != "" else ""))
    if not cond:
        fails.append(name)


# A report with all four sections, shaped like the real one -- including the
# ids that appear on the CONFIRMED section's own EXCLUDED lines, which must
# not be picked up, and one id present in BOTH review sections, which must
# appear once.
REPORT = """FAMILY GROUPING REPORT
Generated: 2026-09-13

CONFIRMED FAMILIES (2) -- clean, unbroken succession chain
  BMW 3 Series  (7 generations, 1975-)
      3 Series (E21)[1975-1983] -> 3 Series (E30)[1982-1994]
      EXCLUDED: 3 Series [1975-] id=m-bmw-3-series -- no succession link
  Porsche 911  (7 generations, 1975-)
      EXCLUDED: 911 (classic) [1964-1989] id=m-porsche-911-classic -- covers two or more

UNCONFIRMED (3) -- candidate group found, NOT auto-grouped, needs review
  Acura Integra  (2 candidates) -- fewer than 2 chronologically-connected generations
      Integra [1985-] id=m-acura-integra
      Integra (2022) [2022-] id=m-acura-integra-2022
  Ford Ranger  (2 candidates) -- fewer than 2 chronologically-connected generations
      Ranger [1982-] id=m-ford-ranger
      Ranger (T6) [2011-] id=m-ford-ranger-t6

NAME COLLISIONS (1) -- unrelated marques sharing a name, correctly not grouped
  Ajax  (2 unrelated articles)
      Ajax [1925-] id=m-ajax-collision

UN-SPLIT NAMEPLATE CANDIDATES (3) -- suggested by credit dates
  Chevrolet Suburban  [1933-2020]  id=m-chevrolet-suburban  -> split into generations
      Wayne Cherry (b. 1937) predates the car's start year
  Jaguar XJS  [1975-1996]  id=m-jaguar-xjs  -> split into generations
      Malcolm Sayer (d. 1970) died well before it
  Acura Integra  [1985-]  id=m-acura-integra  -> split into generations
      someone (b. 1990) predates the car's start year
"""

with tempfile.TemporaryDirectory() as tmp:
    rpath = os.path.join(tmp, "report.txt")
    open(rpath, "w", encoding="utf-8").write(REPORT)
    ids = agent.review_queue_ids(rpath)

    check("the evidence-backed section comes first",
          ids[:2] == ["m-chevrolet-suburban", "m-jaguar-xjs"], ids[:3])
    check("the weaker UNCONFIRMED section follows it",
          ids[3:] == ["m-acura-integra-2022", "m-ford-ranger", "m-ford-ranger-t6"], ids[3:])
    check("an id in both sections appears once, at its strongest position",
          ids.count("m-acura-integra") == 1 and ids.index("m-acura-integra") == 2, ids)

    check("nothing is taken from CONFIRMED, including its EXCLUDED lines",
          "m-bmw-3-series" not in ids and "m-porsche-911-classic" not in ids, ids)
    check("nothing is taken from NAME COLLISIONS -- those are different cars, "
          "not a nameplate to split",
          "m-ajax-collision" not in ids, ids)
    # 3 from UN-SPLIT + 4 from UNCONFIRMED, with Integra shared between them.
    check("every id is accounted for and none invented", len(ids) == 6, len(ids))

    check("a missing report is empty, not an error",
          agent.review_queue_ids(os.path.join(tmp, "nope.txt")) == [])

    # ---- already_scanned ----
    fpath = os.path.join(tmp, "llm_families.json")
    json.dump({
        "families": {"m-jaguar-xjs": {"status": "confirmed"}},
        "recheck": {"m-ford-ranger": {"status": "provisional"}},
        "dismissed": {"m-ford-ranger-t6": True},
    }, open(fpath, "w", encoding="utf-8"))
    scanned = agent.already_scanned(fpath)
    check("a family that already has an entry counts as scanned", "m-jaguar-xjs" in scanned)
    check("so does one with a pending re-check", "m-ford-ranger" in scanned)
    check("a node the user dismissed counts as scanned, so a run cannot "
          "undo that by hand every time", "m-ford-ranger-t6" in scanned)
    check("an unscanned node does not", "m-chevrolet-suburban" not in scanned)

    todo = [i for i in ids if i not in scanned]
    check("the run's target list is the queue minus what is already done",
          todo == ["m-chevrolet-suburban", "m-acura-integra", "m-acura-integra-2022"], todo)

    check("a missing or unreadable file is empty, not an error",
          agent.already_scanned(os.path.join(tmp, "nope.json")) == set())

# ---- naming what changed, so "3 split" is answerable without a diff ----
check("a short list rides along with the summary",
      agent.name_list("split", ["m-a", "m-b"]) == "; split: m-a, m-b",
      agent.name_list("split", ["m-a", "m-b"]))
check("a long list is truncated, since the queue caps a summary at 400 chars",
      agent.name_list("split", ["m-%d" % i for i in range(9)]).endswith("+4 more"),
      agent.name_list("split", ["m-%d" % i for i in range(9)]))
check("an empty list adds nothing", agent.name_list("split", []) == "")

body = agent.commit_body(["m-chevrolet-suburban"], ["m-jaguar-xjs"], [], ["m-gone"], ["m-x: timed out"])
check("the commit body separates what was applied from what is waiting",
      body.index("Split and applied without review") < body.index("Awaiting your review"), body[:80])
check("...names each one", "m-chevrolet-suburban" in body and "m-jaguar-xjs" in body)
check("...reports skips and errors too", "m-gone" in body and "timed out" in body)
check("...and says where to find the agent's own marks",
      'decidedBy:"agent"' in body, body[-90:])
check("with nothing applied it does not claim anything was",
      "Split and applied" not in agent.commit_body([], ["m-a"], [], [], []))
check("the applied heading says it covers the cascade too, not just the seeds",
      "seeds and cascade alike" in agent.commit_body(["m-a"], [], [], [], []))

# ---- what the terminal says while a run is going ----
check("a split says how many generations it found",
      agent.describe({"status": "confirmed", "gens": 7}) == "split into 7 generations",
      agent.describe({"status": "confirmed", "gens": 7}))
check("something waiting for review says so",
      "waiting for you" in agent.describe({"status": "provisional", "gens": 3}))
check("a re-check of an existing nameplate is distinguished from a fresh split",
      agent.describe({"status": "recheck:provisional"}) != agent.describe({"status": "provisional"}))
check("a car with nothing to find says that plainly",
      agent.describe({"status": "none"}) == "no hidden generations")
check("a failed check is not reported as a result",
      agent.describe({"status": "error"}) == "check failed")
check("an unknown status still prints something",
      agent.describe({}) == "checked", agent.describe({}))

# ---- finding the token ----
# An export lasts one shell, so "set CARWEB_AGENT_TOKEN" came back in every
# new terminal, and a scheduled run has no shell to have exported it in.
orig_token_file = agent.TOKEN_FILE
with tempfile.TemporaryDirectory() as home:
    agent.TOKEN_FILE = os.path.join(home, ".carweb-agent-token")

    os.environ["CARWEB_AGENT_TOKEN"] = "  from-the-environment  "
    check("the environment wins when it is set, trimmed",
          agent.read_token() == "from-the-environment", repr(agent.read_token()))

    del os.environ["CARWEB_AGENT_TOKEN"]
    check("with neither, there is no token", agent.read_token() == "", repr(agent.read_token()))

    open(agent.TOKEN_FILE, "w", encoding="utf-8").write("from-the-file\n")
    check("a token file is read, trailing newline and all",
          agent.read_token() == "from-the-file", repr(agent.read_token()))

    os.environ["CARWEB_AGENT_TOKEN"] = "from-the-environment"
    check("...and the environment still wins over it",
          agent.read_token() == "from-the-environment", repr(agent.read_token()))
    del os.environ["CARWEB_AGENT_TOKEN"]
agent.TOKEN_FILE = orig_token_file

check("the token file lives outside the repo -- this repo is public",
      not os.path.abspath(agent.TOKEN_FILE).startswith(ROOT + os.sep), agent.TOKEN_FILE)
check("the missing-token message offers both ways",
      "carweb-agent-token" in agent.NO_TOKEN and "CARWEB_AGENT_TOKEN" in agent.NO_TOKEN)

# ---- what it is allowed to commit ----
check("only the files the pass can write are committable -- the LLM layer and "
      "its script mirror",
      agent.TRACKED == ["app/llm_families.json", "app/llm_families_data.js"], agent.TRACKED)
src = open(os.path.join(ROOT, "scripts", "llm_agent.py"), encoding="utf-8").read()
check("it never stages the whole tree -- this runs unattended in a working "
      "copy that may have anything else half-finished in it",
      '"add", "-A"' not in src and '"add", "."' not in src)
check("the commit carries no Claude attribution",
      "Co-Authored-By" not in src and "Claude" not in src.replace("Claude Browser", ""))

# ---- knowing when a cascade is finished, and when to give up on it ---------
# "The timeout is raised to 900, but is that timer reset to 0 whenever it's
# processing a new car within the cascade?" It was not -- it was a TOTAL, so a
# cascade of eight partners at two minutes each ran past it and got cut off
# exactly like the old one-minute version did, just later. It is an idle cap
# now, the same shape --node-timeout already has.
settle = src.split("def settle_cascade")[1].split("def git(")[0]
check("a car finishing puts the give-up clock back to zero",
      "last, quiet, idle = now, 0, 0" in settle)
check("...and so does the cascade moving on to a different car, before it has "
      "written anything", 'working, idle = pend["names"], 0' in settle)
check("the clock is idle time, not total time", "while idle < settle_seconds" in settle)
check("nothing counts as quiet while the page still has work outstanding",
      'if pend and pend["total"]:' in settle and "continue" in settle)
check("giving up says so in terms of nothing having moved, not of a total",
      "nothing has moved for" in settle)
check("...and names the checks that are about to be lost",
      "were still running and will be lost" in settle)
check("the flag's own help says the clock resets",
      "resets it" in src.split('"--settle-seconds"')[1][:400])

# ---- what is still running when a run ends ---------------------------------
# "the server wasn't closed automatically. I closed it when the program said
# that the changes have been pushed. Therefore I must have been misled into
# closing the server." serve.py only stops the llama-server it started itself,
# and everything it had to say about that went into a pipe nobody read.
check("serve.py's own output is relayed into this terminal, not swallowed",
      "def _relay_output" in src and "serve.py |" in src)
check("...on a daemon thread, so it can never hold the process open at exit",
      "daemon=True" in src.split("def _relay_output")[1].split("def start_serve")[0])
stop = src.split("def stop_serve")[1].split("# ------")[0]
check("the end of a run checks whether the port was really given up",
      "did NOT let go of" in stop)
check("...and says plainly when llama-server is still up and why",
      "STILL RUNNING" in stop and "left it alone" in stop)
check("...and says so when nothing is left, rather than staying silent",
      "nothing left running from this run" in stop)
check("it only ever LOOKS at llama-server -- stopping it is serve.py's job",
      "LLAMA_PORT" in src and "llama-server" not in src.split("subprocess.Popen")[1].split(")")[0])


# ---- Ctrl+C ----------------------------------------------------------------
# "aborting the agent with ctrl + c should gracefully close, not show a
# keyboard interrupt message." The point is not only the missing traceback:
# this run owns a headless browser, a serve.py that owns llama-server with a
# multi-GB model resident, and a job the queue has marked running. Anything
# left behind blocks the next run's port and leaves the site showing a scan
# that never ends.
check("an interrupt is an ordinary exception, not a bare KeyboardInterrupt",
      issubclass(agent.Aborted, Exception) and not issubclass(agent.Aborted, KeyboardInterrupt))
check("nothing is being stopped before one arrives",
      agent.STOPPING is False and agent.CLEANING is False)
check("the browser is closed on every exit from the pass, not only a clean one",
      "finally:" in src.split("def run_pass")[1].split("def _run_pass_in")[0])
check("serve.py is stopped even when the interrupt lands during the model load",
      "except BaseException:" in src.split("def start_serve")[1].split("def stop_serve")[0])
check("--watch does not take the next job after an interrupt",
      "if STOPPING:" in src.split("def do_job")[1].split("def finish")[0])
check("what was already found is still pushed, not thrown away",
      "already paid for in model time" in src)

# The handler itself, exercised rather than read.
_saved = (agent.STOPPING, agent.CLEANING, agent._extra_interrupts)
try:
    raised = False
    try:
        agent._on_signal(signal.SIGINT, None)
    except agent.Aborted:
        raised = True
    check("the first interrupt raises, so every finally gets to run", raised)
    check("...and records that a stop is under way", agent.STOPPING is True)

    agent.begin_cleanup()
    check("cleanup is marked once a stop is under way", agent.CLEANING is True)
    agent._on_signal(signal.SIGINT, None)
    check("a second interrupt during cleanup does NOT unwind it -- that would "
          "strand llama-server and the claimed job", agent._extra_interrupts == 1)
finally:
    agent.STOPPING, agent.CLEANING, agent._extra_interrupts = _saved

# A normal finish stays interruptible: begin_cleanup only latches once a stop
# is already under way, so a slow stop_serve after a successful run can still
# be cut short the graceful way rather than being uninterruptible.
agent.begin_cleanup()
check("a clean run's shutdown is still interruptible", agent.CLEANING is False)

# End to end, for real: start the script, let it settle into a blocking wait,
# press Ctrl+C, and read what a person would actually see. --watch against an
# unreachable queue parks in wait_for_job's poll sleep, which needs no model,
# no browser and no reachable network -- the same blocking shape a real run
# spends nearly all its time in.
env = dict(os.environ, CARWEB_QUEUE_URL="http://127.0.0.1:9", CARWEB_AGENT_TOKEN="test-token")
proc = subprocess.Popen(
    [sys.executable, os.path.join(ROOT, "scripts", "llm_agent.py"), "--watch", "--poll-seconds", "30"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
time.sleep(3)
interrupted = proc.poll() is None
proc.send_signal(signal.SIGINT)
out, _ = proc.communicate(timeout=60)
check("it was still waiting when the interrupt arrived", interrupted, out[-300:])
check("Ctrl+C prints no traceback", "Traceback" not in out, out[-300:])
check("...and no bare KeyboardInterrupt", "KeyboardInterrupt" not in out, out[-300:])
check("...it says it is stopping, in words", "stopping, keeping whatever" in out, out[-300:])
check("...and exits 130, the conventional interrupted code", proc.returncode == 130, proc.returncode)


print()
print("ALL GREEN" if not fails else "FAILURES: " + str(fails))
sys.exit(1 if fails else 0)
