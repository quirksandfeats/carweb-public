#!/usr/bin/env python3
"""serve.py's LLM proxy: the runaway ceiling, and the /api/note line.

Real incident behind both. A single yes/no platform-relation question
("Mercedes-Benz E-Class (C207) <-> Mercedes-Benz C") ran for 874 seconds and
32,060 tokens before being killed by hand: the model had stopped answering
and started looping, and nothing anywhere would ever have stopped it. And
because llama.cpp calls are the ONLY thing that comes through this proxy,
that one line was the only sign of life in the terminal while the app's other
passes -- Wikipedia reads, the engine scan -- ran invisibly beside it, which
is exactly what made the runaway look like useful work.

Never talks to a real llama-server: LLAMA_PORT is pointed at a stub that
streams SSE the same way and reports back what it was asked for.
"""
import json, os, re, subprocess, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(DIR, "..", "app")
PORT = int(os.environ.get("QA_PORT", "8075"))
LLAMA_PORT = int(os.environ.get("QA_LLAMA_PORT", "8076"))
BASE = "http://127.0.0.1:%d" % PORT

fails = 0
def check(name, cond, extra=None):
    global fails
    print(("PASS " if cond else "FAIL ") + name + ("" if extra is None else " -- %s" % (extra,)))
    if not cond: fails += 1

# ---------- the stub llama-server ----------
seen = []          # every request body serve.py forwarded
mode = {"runaway": False}

class Llama(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers()
        self.wfile.write(b"ok")
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        seen.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        def sse(obj):
            self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
            self.wfile.flush()
        if mode["runaway"]:
            # The shape of the real incident: plenty of tokens, then stopped
            # by the ceiling rather than by an answer.
            for _ in range(8):
                sse({"choices": [{"delta": {"content": "loop "}}]})
            sse({"choices": [{"delta": {}, "finish_reason": "length"}]})
        else:
            sse({"choices": [{"delta": {"content": '{"ok":true}'}}]})
            sse({"choices": [{"delta": {}, "finish_reason": "stop"}],
                 "timings": {"predicted_per_second": 42.0, "predicted_n": 3}})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

llama = ThreadingHTTPServer(("127.0.0.1", LLAMA_PORT), Llama)
threading.Thread(target=llama.serve_forever, daemon=True).start()

def post(path, body, timeout=20):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

env = dict(os.environ, LLAMA_PORT=str(LLAMA_PORT), CARWEB_SKIP_DB_REFRESH="1",
           LLAMA_MAX_TOKENS="64", LLAMA_RUNAWAY_TOKENS="4")
srv = subprocess.Popen([sys.executable, "-u", os.path.join(APP, "serve.py"), str(PORT)],
                       env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
out = []
threading.Thread(target=lambda: [out.append(l) for l in srv.stdout], daemon=True).start()

def terminal():
    return "".join(out)

try:
    for _ in range(80):
        try:
            post("/api/note", {"text": "waking"}); break
        except Exception:
            time.sleep(0.25)

    # ---------- 1. the ceiling ----------
    st, d = post("/api/llm/chat", {"messages": [{"role": "user", "content": "hi"}],
                                   "purpose": "Mercedes-Benz E-Class (C207) <-> Mercedes-Benz C - platform"})
    check("a normal call still answers", st == 200 and d["choices"][0]["message"]["content"] == '{"ok":true}',
          (st, d.get("choices")))
    check("the proxy imposes a token ceiling the client never asked for",
          seen[-1].get("max_tokens") == 64, seen[-1].get("max_tokens"))
    check("...and streaming is still forced on", seen[-1].get("stream") is True)

    st, d = post("/api/llm/chat", {"messages": [], "max_tokens": 7, "purpose": "x"})
    check("a caller that sets its own limit keeps it", seen[-1].get("max_tokens") == 7,
          seen[-1].get("max_tokens"))

    # ---------- 2. what the terminal says about a runaway ----------
    before = len(terminal())
    mode["runaway"] = True
    st, d = post("/api/llm/chat", {"messages": [], "purpose": "Mercedes-Benz E-Class (C207) <-> Mercedes-Benz C - platform"})
    time.sleep(0.4)
    tail = terminal()[before:]
    check("a call the ceiling cut short is reported as cut off, not as done",
          "CUT OFF" in tail, tail.strip().splitlines()[-1:] )
    check("...and says plainly that nothing was learned from it",
          "Nothing was learned" in tail)
    check("...rather than the ordinary success summary", "-- done," not in tail,
          [l for l in tail.splitlines() if "done," in l])
    mode["runaway"] = False

    # ---------- 3. the passes that are not model calls ----------
    before = len(terminal())
    st, d = post("/api/note", {"text": "powertrain: reading engines for E-Class -- 6 article(s) to check"})
    time.sleep(0.3)
    check("the page can say what it is doing", st == 200 and d.get("ok") is True, (st, d))
    check("...and it lands in the same terminal as the model calls",
          "[app] powertrain: reading engines for E-Class" in terminal()[before:],
          terminal()[before:].strip())

    before = len(terminal())
    post("/api/note", {"text": "x" * 500})
    time.sleep(0.3)
    line = [l for l in terminal()[before:].splitlines() if l.startswith("[app]")]
    check("a note cannot flood the terminal", line and len(line[0]) < 260, line and len(line[0]))

    before = len(terminal())
    post("/api/note", {"text": "   "})
    time.sleep(0.3)
    check("an empty note prints nothing",
          not [l for l in terminal()[before:].splitlines() if l.startswith("[app]")])
finally:
    srv.terminate()
    try: srv.wait(timeout=10)
    except Exception: srv.kill()
    llama.shutdown()

print("\n%s" % ("ALL GREEN" if not fails else "%d failure(s)" % fails))
sys.exit(1 if fails else 0)
