#!/usr/bin/env python3
"""Stand-in for a local llama-server, used only for QA -- this sandbox has
no real llama.cpp/qwen3.5 to talk to. Mimics llama-server's OpenAI-compatible
/v1/chat/completions STREAMING response shape (Server-Sent Events, one
"data: {...}" line per chunk, a final chunk carrying "timings", then
"data: [DONE]") closely enough to exercise serve.py's proxy (which always
requests streaming internally -- see serve.py's own do_POST comment) and
llm_families.js's parsing/validation end to end. Always returns the same
canned G-Class generation breakdown, plus one deliberately fabricated
chassis code ("FAKEXYZ") that does NOT appear in the real Wikipedia article,
to verify the hallucination guard actually drops it rather than trusting the
model blindly.

Superseded qa/stub_ollama.py (kept in place as a pointer to this file --
see its own docstring) when this app moved from Ollama to llama.cpp.
"""
import http.server
import json
import sys
import time

PAYLOAD = {
    "hasMultipleGenerations": True,
    "generations": [
        {"code": "W460", "yearStart": 1979, "yearEnd": 1991, "designers": [], "engineers": []},
        {"code": "W461", "yearStart": 1991, "yearEnd": None, "designers": [], "engineers": []},
        {"code": "W463", "yearStart": 1990, "yearEnd": None, "designers": [], "engineers": []},
        {"code": "FAKEXYZ", "yearStart": 2099, "yearEnd": None, "designers": ["Nobody Real"], "engineers": []},
    ],
}
PAYLOAD_STR = json.dumps(PAYLOAD)


def _sse_chunk(delta_content=None, finish_reason=None, timings=None):
    choice = {"index": 0, "delta": ({"content": delta_content} if delta_content is not None else {}), "finish_reason": finish_reason}
    obj = {"model": "qwen3.5-9b-mtp", "choices": [choice]}
    if timings is not None:
        obj["timings"] = timings
    return ("data: " + json.dumps(obj) + "\n\n").encode("utf-8")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[stub-llama-server] %s\n" % (fmt % args))

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"status": "ok"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get("Content-Length", 0))
        _req = json.loads(self.rfile.read(length) or b"{}")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        # Split the canned JSON answer into a handful of streamed chunks
        # (real token-by-token granularity doesn't matter for these tests --
        # what matters is that serve.py's proxy correctly accumulates
        # several chunks into one complete response). A couple of them
        # deliberately land mid-way through the JSON so any parser that
        # assumes one chunk == one complete JSON object would fail loudly.
        step = max(1, len(PAYLOAD_STR) // 6)
        pieces = [PAYLOAD_STR[i:i + step] for i in range(0, len(PAYLOAD_STR), step)]
        n_tokens = 0
        t0 = time.monotonic()
        for piece in pieces:
            self.wfile.write(_sse_chunk(delta_content=piece))
            self.wfile.flush()
            n_tokens += 1
        elapsed = max(time.monotonic() - t0, 0.001)
        final_timings = {
            "predicted_n": n_tokens,
            "predicted_ms": elapsed * 1000,
            "predicted_per_second": n_tokens / elapsed,
            "prompt_n": 1,
            "prompt_ms": 1.0,
            "prompt_per_second": 1000.0,
        }
        self.wfile.write(_sse_chunk(finish_reason="stop", timings=final_timings))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    with http.server.ThreadingHTTPServer(("localhost", port), Handler) as httpd:
        print(f"stub llama-server listening on :{port}")
        httpd.serve_forever()
