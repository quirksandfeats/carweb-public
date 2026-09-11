#!/usr/bin/env python3
"""Exercises serve.py's /api/rebuild endpoint against a STUB rebuild script.

Deliberately never runs data_src/rebuild.sh itself: that script really does
re-harvest from DBpedia and overwrite app/data.js, app/cars.json,
app/db_photos/ and the match report. A test must not do that to a working
copy, so REBUILD_SCRIPT is pointed at a fake that prints the same
"-- step --" banners the real one does and exits.
"""
import json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(DIR, "..", "app")
PORT = int(os.environ.get("QA_PORT", "8074"))
BASE = "http://127.0.0.1:%d" % PORT

fails = 0
def check(name, cond, extra=None):
    global fails
    print(("PASS " if cond else "FAIL ") + name + ("" if extra is None else " -- %s" % (extra,)))
    if not cond: fails += 1

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return r.status, json.loads(r.read().decode())

def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

stub = tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False)
stub.write("""#!/bin/bash
echo "-- harvesting fresh data (needs internet, ~1-2 min) --"
sleep 1
echo "-- merging harvest into source tables --"
sleep 1
echo "-- building the graph --"
sleep 1
if [ "$1" = "--fail" ]; then echo "boom"; exit 3; fi
echo "-- done --"
""")
stub.close()
os.chmod(stub.name, 0o755)

# CARWEB_SKIP_DB_REFRESH: serve.py normally refreshes the My Database layer at
# startup, which re-downloads every car photo. A test must not rewrite a
# working copy's images just to poke one endpoint.
env = dict(os.environ, REBUILD_SCRIPT=stub.name, LLAMA_PORT="8079",
           CARWEB_SKIP_DB_REFRESH="1")
srv = subprocess.Popen([sys.executable, os.path.join(APP, "serve.py"), str(PORT)],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try:
            get("/api/rebuild"); break
        except Exception:
            time.sleep(0.5)

    st, d = get("/api/rebuild")
    check("idle status reports not running", d["running"] is False, d["step"])
    check("the rebuild script is found", d["scriptExists"] is True)

    st, d = post("/api/rebuild", {})
    check("POST starts a rebuild", st == 200 and d.get("started") is True, (st, d))

    st, d = post("/api/rebuild", {})
    check("a second POST while running is refused, not queued", st == 409, (st, d))

    steps, ran = set(), False
    for _ in range(60):
        st, d = get("/api/rebuild")
        if d["step"]: steps.add(d["step"])
        if not d["running"]: ran = True; break
        time.sleep(0.5)
    check("the rebuild finished", ran)
    check("progress reported real step names from the script", len(steps) >= 2, sorted(steps))
    check("success is reported as ok", d["ok"] is True, (d["ok"], d.get("returncode")))
    check("elapsed time is reported", isinstance(d.get("elapsed"), (int, float)), d.get("elapsed"))
    check("the log tail came through", any("building the graph" in l for l in d["log"]), d["log"][-3:])

    # a failing rebuild must report failure, not silent success
    srv.terminate(); srv.wait(timeout=10)
    env2 = dict(env, REBUILD_SCRIPT=stub.name)
    srv = subprocess.Popen([sys.executable, os.path.join(APP, "serve.py"), str(PORT)],
                           env=env2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try: get("/api/rebuild"); break
        except Exception: time.sleep(0.5)
    os.chmod(stub.name, 0o755)
    with open(stub.name, "a") as f: f.write("exit 3\n")
    post("/api/rebuild", {})
    for _ in range(60):
        st, d = get("/api/rebuild")
        if not d["running"]: break
        time.sleep(0.5)
    check("a failing rebuild reports ok=false", d["ok"] is False, (d["ok"], d.get("returncode")))
    check("...and says so in the step", d["step"] == "failed", d["step"])

    # a missing script must be a clean error, not a crash
    srv.terminate(); srv.wait(timeout=10)
    env3 = dict(env, REBUILD_SCRIPT="/nonexistent/rebuild.sh")
    srv = subprocess.Popen([sys.executable, os.path.join(APP, "serve.py"), str(PORT)],
                           env=env3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try: get("/api/rebuild"); break
        except Exception: time.sleep(0.5)
    st, d = post("/api/rebuild", {})
    check("a missing rebuild script is a clean 500, not a crash", st == 500 and "error" in d, (st, d))
finally:
    srv.terminate()
    try: srv.wait(timeout=10)
    except Exception: srv.kill()
    os.unlink(stub.name)

print("\n%s" % ("ALL GREEN" if not fails else "%d failure(s)" % fails))
sys.exit(1 if fails else 0)
