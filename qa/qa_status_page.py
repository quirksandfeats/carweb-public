#!/usr/bin/env python3
"""scripts/status_page.py through one agent run, written to a temporary folder.

Real user request: the status page should start with the agent, refresh while
it runs, and end with a final report "explaining its current status as being
completed and so on" -- however the agent stops. The agent tells the page which
request it is on and when it finishes, because the queue service can drop a
running request (the Mazda CX-5's, 14 Oct 2026) and never record its end.
Reads the real store; the queue may or may not be reachable.
"""
import glob, os, re, sys, tempfile, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import status_page as sp

fails = 0
def check(name, cond, extra=None):
    global fails
    print(("PASS " if cond else "FAIL ") + name + ("" if extra is None else " -- %s" % (extra,)))
    if not cond: fails += 1

d = tempfile.mkdtemp()
out = os.path.join(d, "CarWeb scan status.html")
text = lambda: re.sub(r"\s+", " ", re.sub(r"<style.*?</style>|<[^>]+>", " ", open(out, encoding="utf-8").read(), flags=re.S))
check("the page's path is not in the repository: it comes from a git-ignored settings file",
      "agent_settings.local.json" in open(os.path.join(os.path.dirname(sp.__file__), "..", ".gitignore")).read())
sp.start(out, interval_min=15, say=lambda m: None)
time.sleep(2)
check("written as the agent starts", os.path.exists(out))
check("...saying when the next update is", "Next update" in text())
sp.job_started({"id": "qa-job-1", "targetId": "qa-car", "targetLabel": "QA Test Car"})
check("the request the agent is on is shown, without the queue", "QA Test Car" in text())
sp.job_finished("qa-job-1", "done", "QA summary")
sp.final()
t = text()
check("the final report says the run is over", "Final report" in t and "has stopped" in t, t[:160])
check("...and counts the request the agent finished, though the queue never recorded it",
      "Requests finished in this run: 1" in t, t[t.find("Final report"):][:240])
check("...and keeps a dated copy", len(glob.glob(os.path.join(d, "CarWeb final report *.html"))) == 1)
check("a second final write does nothing", sp.final() is None)
print("\n%s" % ("ALL PASS" if not fails else "%d FAILED" % fails))
sys.exit(1 if fails else 0)
