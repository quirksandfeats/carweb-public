#!/usr/bin/env python3
"""Re-read every car's engines, unattended.

    caffeinate -i .venv/bin/python scripts/reread_engines.py

Owner's report: "⚙ Re-read Engines" only made progress while its page was open
and in front. The button's loop runs in the page, and a browser slows a page
that is hidden (a tab behind another, a minimised window, the screen saver) to
about one step a minute; a Mac that sleeps stops it outright. This does what the
button does, in a headless browser nothing slows down. `caffeinate -i` keeps the
Mac awake while it runs.

It is the button, not a second copy of it: the page is the app itself, served
from this repo, and the script presses "Re-read Engines" and watches the button's
own progress. Each car's read is saved as it finishes, so Ctrl-C loses at most
the car in hand, and the next run starts from what is still due.

The store is served by serve.py's own request handler, in this process, on a
port of its own (8078) and without the local model, which an engine read never
calls. Two serve.py processes writing llm_families.json at once can overwrite
each other's last save, so while any other serve.py runs (the agent's during a
queued scan, or one you started) this one stops after the car in hand and waits
until it has gone.

The page is reloaded every --batch cars, to keep its memory down over a run of
thousands; a car whose read has not moved for ten minutes, a crashed tab or a
load that timed out is met with a fresh page too. The run ends when nothing is
due, when a load gets no further, or after five failed loads in a row.
Nothing is committed: the reads land in app/llm_families.json, and go out with
the next commit of the store (the agent's, after its next scan).
"""
import argparse
import importlib.util
import http.server
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
BUTTON = "#rereadenginesbtn"


def log(msg):
    print(time.strftime("%H:%M:%S ") + msg, flush=True)


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def other_serve_running(own_port):
    """Another serve.py: the agent's, or one started by hand."""
    if own_port != 8077 and port_open(8077):
        return True
    try:
        out = subprocess.run(["pgrep", "-f", r"serve\.py"], capture_output=True, text=True).stdout.split()
    except Exception:
        return False
    return any(pid.strip() and int(pid) != os.getpid() for pid in out)


def start_store_server(port, verbose):
    """serve.py's handler, with no model behind it. The page's own notes ("[app]
    powertrain: ...") are printed only with --verbose: thousands of cars make
    tens of thousands of lines."""
    spec = importlib.util.spec_from_file_location("carweb_serve", os.path.join(APP, "serve.py"))
    serve = importlib.util.module_from_spec(spec)
    argv = sys.argv
    sys.argv = ["serve.py"]
    try:
        spec.loader.exec_module(serve)
    finally:
        sys.argv = argv
    serve.Handler.log_message = lambda self, fmt, *args: None
    if not verbose and hasattr(serve, "_print_live"):
        serve._print_live = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(("localhost", port), serve.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def use_repo_venv():
    """playwright lives in the repo's .venv, as for llm_agent.py."""
    if importlib.util.find_spec("playwright") is not None:
        return
    venv = os.path.join(ROOT, ".venv")
    venv_py = os.path.join(venv, "bin", "python")
    if os.path.exists(venv_py) and os.path.realpath(sys.prefix) != os.path.realpath(venv) \
            and not os.environ.get("CARWEB_REREAD_REEXEC"):
        os.environ["CARWEB_REREAD_REEXEC"] = "1"
        os.execv(venv_py, [venv_py, os.path.abspath(__file__)] + sys.argv[1:])
    sys.exit("playwright is not installed -- run: python3 -m venv .venv && "
             ".venv/bin/pip install -q playwright && .venv/bin/python -m playwright install chromium")


def boot(browser, port):
    page = browser.new_page()
    # ?agent=1: the page recovers its saved scan queue but does not start it.
    # This run reads engines and nothing else.
    page.goto(f"http://localhost:{port}/index.html?agent=1", wait_until="domcontentloaded", timeout=120000)
    page.wait_for_function("() => window.__carwebReady === true", timeout=600000)
    if not page.evaluate("() => !!(window.LlmFamilies && window.LlmFamilies.serverAvailable)"):
        raise RuntimeError("the page cannot see the store server, so nothing could be saved")
    return page


def due_count(page):
    return page.evaluate("() => window.LlmFamilies.engineReadsDue(window.CARDATA.nodes).length")


def label(page):
    return (page.text_content(BUTTON) or "").strip()


def running(text):
    return text.startswith("⚙ Re-reading") or text.startswith("⚙ Stopping")


def stop_and_wait(page, timeout=600):
    """Press the button again: it finishes the car in hand, saves, and stops."""
    if running(label(page)) and not label(page).startswith("⚙ Stopping"):
        page.evaluate(f"() => document.querySelector('{BUTTON}').click()")
    end = time.time() + timeout
    while time.time() < end and running(label(page)):
        time.sleep(2)
    # The last save is sent after the loop ends; give it a moment to land.
    time.sleep(5)


STALL_SECONDS = 600       # a car whose read has not moved for this long is given up on, by a reload
FAILURES_IN_A_ROW = 5     # page crashes or load timeouts in a row before the run gives up


def wait_while_other_serve(own_port):
    """True when it had to wait: what was due may have changed meanwhile."""
    waited = False
    while other_serve_running(own_port):
        if not waited:
            log("another serve.py is running (the agent's, or yours); waiting for it to stop")
        waited = True
        time.sleep(60)
    return waited


def run_load(browser, args, state):
    """One page load: read up to --batch cars. Returns "done", "stuck", "paused" or "more"."""
    page = boot(browser, args.port)
    state["page"] = page
    try:
        return read_in(page, args, state)
    except KeyboardInterrupt:
        # The car in hand is finished and saved first; the browser ignores Ctrl-C.
        log("Ctrl-C: stopping after the car in hand")
        try:
            stop_and_wait(page, timeout=120)
        except Exception:
            pass
        raise
    finally:
        state["page"] = None
        try:
            page.close()
        except Exception:
            pass


def read_in(page, args, state):
    """Read up to --batch cars on a loaded page."""
    due = due_count(page)
    if state["first_due"] is None:
        state["first_due"] = due
    log(f"{due} car(s) due" + (f" ({state['first_due'] - due} read so far)" if state["first_due"] != due else ""))
    if not due:
        return "done"
    if state["last_due"] is not None and due >= state["last_due"]:
        log("the last load got no further (pages that would not load stay due); stopping")
        return "stuck"
    state["last_due"] = due
    want = min(args.batch, args.limit - state["total"]) if args.limit else args.batch
    page.evaluate(f"() => document.querySelector('{BUTTON}').click()")
    said, moved, step, outcome = "", time.time(), 0, "more"
    while True:
        time.sleep(10)
        text = label(page)
        if text != said:
            said, moved = text, time.time()
            m = re.match(r"⚙ Re-reading (\d+)/(\d+)", text)
            if m:
                step = int(m.group(1))
                if step % 25 == 0:
                    log(f"{step}/{m.group(2)} this load -- {text.split('— ', 1)[-1].split(' (click')[0]}")
        if not running(text):
            break
        if step >= want:
            stop_and_wait(page)
            break
        if other_serve_running(args.port):
            log("another serve.py started; stopping after this car")
            stop_and_wait(page)
            outcome = "paused"
            break
        if time.time() - moved > STALL_SECONDS:
            log(f"no progress for {STALL_SECONDS // 60} minutes on: {text}; reloading")
            break
    # What this load read: what was due, less what still is.
    try:
        read = due - due_count(page)
    except Exception:
        read = 0
    state["total"] += max(read, 0)
    log(f"{read} read this load, {state['total']} in all")
    return outcome


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8078, help="port for this run's store server (default 8078)")
    ap.add_argument("--batch", type=int, default=300, help="cars per page load (default 300)")
    ap.add_argument("--limit", type=int, default=0, help="stop after about this many cars in all (default: no limit)")
    ap.add_argument("--verbose", action="store_true", help="print the page's own notes for every car")
    args = ap.parse_args()
    use_repo_venv()
    # Ctrl-C, and a plain kill, stop it after the car in hand -- also when it
    # was started in the background, where Ctrl-C would otherwise be ignored.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    from playwright.sync_api import sync_playwright

    if port_open(args.port):
        sys.exit(f"something is already listening on :{args.port} -- pass --port to use another")
    wait_while_other_serve(args.port)
    httpd = start_store_server(args.port, args.verbose)
    log(f"store server on :{args.port} (no model)")
    state = {"total": 0, "first_due": None, "last_due": None, "page": None}
    p = browser = None
    try:
        p = sync_playwright().start()
        # Ctrl-C is this script's to handle: the browser is closed after the car in hand.
        browser = p.chromium.launch(headless=True, handle_sigint=False,
                                    args=["--disable-gpu", "--js-flags=--max-old-space-size=4096"])
        failures = 0
        while True:
            if wait_while_other_serve(args.port):
                state["last_due"] = None
            try:
                outcome = run_load(browser, args, state)
                failures = 0
            except Exception as e:
                # A crashed tab or a load that timed out: a fresh page picks up what is still due.
                failures += 1
                log(f"the page failed ({str(e).splitlines()[0][:160]}); {failures} in a row")
                if failures >= FAILURES_IN_A_ROW:
                    log("giving up after that many failures in a row; run it again to carry on")
                    break
                state["last_due"] = None
                if not browser.is_connected():
                    browser = p.chromium.launch(headless=True, handle_sigint=False,
                                                args=["--disable-gpu", "--js-flags=--max-old-space-size=4096"])
                continue
            if outcome in ("done", "stuck"):
                break
            if outcome == "paused":
                state["last_due"] = None
            if args.limit and state["total"] >= args.limit:
                break
    except KeyboardInterrupt:
        log("stopped")
    finally:
        for close in (lambda: browser and browser.close(), lambda: p and p.stop(), httpd.shutdown):
            try:
                close()
            except Exception:
                pass
    log(f"done: {state['total']} car(s) re-read")


if __name__ == "__main__":
    main()
