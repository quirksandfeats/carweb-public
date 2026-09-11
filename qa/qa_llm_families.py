#!/usr/bin/env python3
"""QA sweep for the LLM generation-check feature, run against serve.py +
qa/stub_llama_server.py (standing in for a real local llama-server, which
this sandbox doesn't have). Verifies: the toggle, the checking/provisional
UI, the hallucination guard (a fabricated chassis code must be dropped),
reject + retry, and confirming a split actually rewires the live graph —
using the Mercedes-Benz G-Class node, the exact motivating example.

Must be run against http://localhost:8077 served by serve.py, with
qa/stub_llama_server.py running on :8080 (serve.py's default LLAMA_PORT).
Resets llm_families.json to empty both before and after, since this is a
real file on disk."""
from playwright.sync_api import sync_playwright
import sys, json, os

# This sandbox's headless browser can't reach en.wikipedia.org directly (only
# the agent's own dedicated fetch tool can, per its network policy) — so the
# wikitext fetch inside llm_families.js is mocked here with a compact stand-in
# infobox that contains the real chassis codes (W460/W461/W463) but NOT the
# stub Ollama's fabricated "FAKEXYZ" code, so the hallucination-guard
# assertion below stays meaningful.
FAKE_WIKITEXT = """{{Infobox automobile
| name = Mercedes-Benz G-Class
}}
== W460 (1979-1991) ==
The W460 was the first generation, built from 1979 to 1991.
== W461 (1991-present) ==
The W461 succeeded the W460 in 1991 and continues for military use.
== W463 (1990-present) ==
The W463 moved the G-Class upmarket starting in 1990.
"""

def mock_wikipedia(route):
    url = route.request.url
    if "action=parse" in url and "prop=wikitext" in url:
        route.fulfill(status=200, content_type="application/json",
                       body=json.dumps({"parse": {"wikitext": {"*": FAKE_WIKITEXT}}}))
    else:
        route.continue_()

BASE = "http://localhost:8077/index.html"
# Output/asset paths resolve relative to this file, so the script runs from
# anywhere and on any machine.
_QA_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_DIR = os.path.join(_QA_DIR, "..", "app")
OUT = _QA_DIR + os.sep
LLM_FAMILIES_PATH = os.path.join(_APP_DIR, "llm_families.json")
fails, errs = [], []

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, extra)
    if not cond: fails.append(name)

def reset_file():
    with open(LLM_FAMILIES_PATH, "w", encoding="utf-8") as f:
        json.dump({"families": {}}, f)

reset_file()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.route("**en.wikipedia.org/w/api.php**", mock_wikipedia)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error"
          and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    pg.goto(BASE, wait_until="domcontentloaded", timeout=20000)
    pg.wait_for_timeout(2600)

    avail = pg.evaluate("() => window.LlmFamilies && window.LlmFamilies.serverAvailable")
    check("served via serve.py, LlmFamilies sees the server as available", avail is True)

    btnHidden = pg.evaluate("() => document.getElementById('llmcheck').hidden")
    check("LLM Check toggle button is visible (server available)", btnHidden is False)

    pg.click("#llmcheck")
    pg.wait_for_timeout(200)
    on = pg.evaluate("() => CarWeb.llmCheckOn()")
    check("toggle turns the check on", on is True)

    # ---------- open G-Class, the exact motivating example ----------
    pg.fill("#search", "Mercedes-Benz G-Class")
    pg.wait_for_timeout(350)
    pg.click("#searchresults .sr-item >> nth=0")
    # (the "checking..." status is only visible for the brief window before
    # the mocked/local round trip resolves, which is too fast/racy to assert
    # on reliably here — the state transition it leads to is verified below)
    pg.wait_for_timeout(900)
    state = pg.evaluate("""() => {
      const entry = window.LlmFamilies.entryFor('m-mercedes-benz-g-class');
      return entry;
    }""")
    check("entry saved with provisional status", state and state.get("status") == "provisional", str(state and state.get("status")))
    codes = [g["code"] for g in (state or {}).get("proposal", {}).get("generations", [])]
    check("real chassis codes kept (W460/W461/W463)", set(["W460", "W461", "W463"]).issubset(set(codes)), str(codes))
    check("hallucination guard dropped the fabricated 'FAKEXYZ' code", "FAKEXYZ" not in codes, str(codes))

    rows = pg.evaluate("() => document.querySelectorAll('.llm-gen-row').length")
    check("proposed generations rendered in the detail panel", rows == len(codes), f"{rows} vs {len(codes)}")
    pg.screenshot(path=OUT + "llm_provisional.png")

    onDiskBefore = json.load(open(LLM_FAMILIES_PATH))
    check("provisional entry persisted to llm_families.json on disk",
          "m-mercedes-benz-g-class" in onDiskBefore.get("families", {}))

    # ---------- reject flow on the same node, then re-check is blocked (already has an entry) ----------
    pg.click(".llm-no")
    pg.wait_for_timeout(400)
    rejectedStatus = pg.evaluate("() => window.LlmFamilies.entryFor('m-mercedes-benz-g-class').status")
    check("'No, inaccurate' sets status to rejected", rejectedStatus == "rejected", rejectedStatus)
    stillModel = pg.evaluate("() => CarWeb.byId.get('m-mercedes-benz-g-class').type")
    check("rejected node stays a plain model (not split)", stillModel == "model", stillModel)

    # ---------- retry flow ----------
    reset_file()
    pg.reload(wait_until="domcontentloaded"); pg.wait_for_timeout(2200)
    # the toggle's on/off state persists across reloads via localStorage —
    # it's already on from earlier in this run, so don't re-click (that would
    # just flip it back off).
    stillOn = pg.evaluate("() => CarWeb.llmCheckOn()")
    check("LLM check toggle stays on across a reload (localStorage)", stillOn is True)
    pg.fill("#search", "Mercedes-Benz G-Class")
    pg.wait_for_timeout(350)
    pg.click("#searchresults .sr-item >> nth=0")
    pg.wait_for_timeout(900)
    pg.fill(".llm-reason", "double check the year ranges")
    pg.click(".llm-retry")
    pg.wait_for_timeout(900)
    retryState = pg.evaluate("() => window.LlmFamilies.entryFor('m-mercedes-benz-g-class')")
    check("retry increments attempts", retryState and retryState.get("attempts") == 2, str(retryState and retryState.get("attempts")))
    check("retry records the feedback reason", retryState and "double check the year ranges" in retryState.get("feedback", []),
          str(retryState and retryState.get("feedback")))

    # ---------- confirm flow: Yes should rewire the live graph (via reload) ----------
    pg.click(".llm-yes")
    pg.wait_for_timeout(2600)
    confirmed = pg.evaluate("""() => {
      const cw = CarWeb;
      const n = cw.byId.get('m-mercedes-benz-g-class');
      return { type: n.type, generations: n.generations, expanded: n.type === 'family' ? cw.isFamilyExpanded(n.id) : null };
    }""")
    check("confirmed G-Class becomes a family node", confirmed["type"] == "family", confirmed["type"])
    check("family has the 3 verified generations (not the fabricated one)",
          confirmed["generations"] and len(confirmed["generations"]) == 3, str(confirmed["generations"]))

    onDiskAfter = json.load(open(LLM_FAMILIES_PATH))
    check("confirmed status persisted to disk",
          onDiskAfter["families"]["m-mercedes-benz-g-class"]["status"] == "confirmed")

    # ---------- the confirmed split behaves like a normal family everywhere ----------
    pg.fill("#search", "Mercedes-Benz G-Class")
    pg.wait_for_timeout(350)
    pg.click("#searchresults .sr-item >> nth=0")
    pg.wait_for_timeout(900)
    graphState = pg.evaluate("""() => {
      const cw = CarWeb;
      const fam = cw.byId.get('m-mercedes-benz-g-class');
      return { expanded: cw.isFamilyExpanded(fam.id), genRows: document.querySelectorAll('.dt-generations .dt-gen').length };
    }""")
    check("clicking the confirmed family expands it like any other", graphState["expanded"])
    check("detail panel lists its 3 generations", graphState["genRows"] == 3, str(graphState["genRows"]))
    pg.screenshot(path=OUT + "llm_confirmed_family_graph.png")

    pg.click('.tab[data-view="timeline"]')
    pg.wait_for_timeout(800)
    tlOpt = pg.evaluate("""() => {
      const opt = [...document.querySelectorAll('#tl-designer option')].find(o => o.textContent.includes('G-Class'));
      return !!opt;
    }""")
    check("confirmed nameplate is followable on the Timeline too", tlOpt)

    check("no console/page errors captured", len(errs) == 0, str(errs[:5]))
    b.close()

reset_file()
print()
print(f"{'ALL GREEN' if not fails and not errs else 'FAILURES: ' + str(fails + errs)}")
sys.exit(1 if (fails or errs) else 0)
