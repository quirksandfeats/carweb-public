#!/usr/bin/env python3
"""Full QA sweep: screenshots + functional assertions for The Car Web."""
from playwright.sync_api import sync_playwright
import json, os, sys

BASE = "http://localhost:8077/index.html"
# Screenshots land next to this script, so it runs from anywhere.
OUT = os.path.dirname(os.path.abspath(__file__)) + os.sep
fails, errs = [], []

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, extra)
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width":1440,"height":900})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    pg.goto(BASE, wait_until="domcontentloaded", timeout=20000)
    pg.wait_for_function("() => window.__carwebReady === true", timeout=180000)  # see index.html\'s loader

    # ---------- data sanity in page ----------
    sanity = pg.evaluate("""() => {
      const cw = CarWeb, out = {};
      out.nodes = cw.nodes.length;
      out.models = cw.nodes.filter(n=>n.type==='model').length;
      // symmetric adjacency
      out.adjOK = cw.nodes.every(n => cw.adj.get(n.id).every(({n:o,l}) => cw.adj.get(o.id).some(x=>x.l===l)));
      // FR-S neighbors include Toyota 86 via platform
      const frs = cw.nodes.find(n=>n.label==='FR-S');
      out.frsPlat = cw.adj.get(frs.id).filter(a=>a.l.type==='platform').map(a=>a.n.label).sort();
      // every node has coordinates
      out.coordsOK = cw.nodes.every(n => isFinite(n.x) && isFinite(n.y));
      return out;
    }""")
    check("graph data loaded", sanity["nodes"] == 591, str(sanity["nodes"]))
    check("adjacency symmetric", sanity["adjOK"])
    check("FR-S platform twins", sanity["frsPlat"] == ["86","BRZ"], str(sanity["frsPlat"]))
    check("layout coords finite", sanity["coordsOK"])

    # ---------- search ----------
    res = pg.evaluate("() => CarWeb.searchAll('countach').map(n=>n.label)")
    check("search countach", "Countach" in res, str(res[:3]))
    res = pg.evaluate("() => CarWeb.searchAll('gandini').map(n=>n.label)")
    check("search designer name surfaces models+designer", "Marcello Gandini" in res, str(res[:4]))
    pg.fill("#search", "Scion FR")
    pg.wait_for_timeout(300)
    n_results = pg.evaluate("() => document.querySelectorAll('#searchresults .sr-item').length")
    check("search dropdown renders", n_results > 0, f"{n_results} items")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(1400)
    detail = pg.inner_text("#detail .dt-title")
    check("search->fly->detail", "FR-S" in detail, detail)
    conns = pg.inner_text("#detail .dt-connections")
    check("detail shows platform siblings", "86" in conns and "BRZ" in conns)
    pg.screenshot(path=OUT+"shot_focus_frs.png")

    # focus set applied?
    foc = pg.evaluate("() => CarWeb ? (document.getElementById('clearfocus').hidden===false) : null")
    check("focus mode engaged", foc)

    # ---------- six degrees ----------
    pg.click("[data-view=sixdeg]")
    pg.wait_for_timeout(400)
    path = pg.evaluate("""() => {
      const cw = CarWeb;
      const a = cw.nodes.find(n=>n.label==='FR-S');
      const b = cw.nodes.find(n=>n.label==='Marcello Gandini');
      // use the module's BFS through the UI: fill pickers programmatically instead
      return {a: !!a, b: !!b};
    }""")
    pg.fill("#sd-from", "Scion FR-S"); pg.wait_for_timeout(250)
    pg.evaluate("() => document.querySelector('#sd-from + .sd-results .sr-item, .sd-pick .sd-results .sr-item').dispatchEvent(new MouseEvent('mousedown'))")
    pg.fill("#sd-to", "Marcello Gandini"); pg.wait_for_timeout(250)
    pg.evaluate("() => {const rs=[...document.querySelectorAll('.sd-pick .sd-results')].pop(); rs.querySelector('.sr-item').dispatchEvent(new MouseEvent('mousedown'))}")
    pg.wait_for_timeout(200)
    disabled = pg.evaluate("() => document.getElementById('sd-go').disabled")
    check("six-degrees ready", disabled == False)
    pg.click("#sd-go")
    pg.wait_for_timeout(300)
    steps = pg.evaluate("() => [...document.querySelectorAll('#sd-steps li b')].map(e=>e.textContent)")
    check("path found", len(steps) >= 3, " -> ".join(steps))
    pg.wait_for_timeout(len(steps)*800 + 800)
    pg.screenshot(path=OUT+"shot_sixdeg.png")

    # ---------- timeline ----------
    pg.click("[data-view=timeline]")
    pg.wait_for_timeout(700)
    ndots = pg.evaluate("() => document.querySelectorAll('.tl-dot').length")
    check("timeline dots", ndots == sanity["models"], f"{ndots} dots")
    pg.select_option("#tl-designer", "Giorgetto Giugiaro")
    pg.wait_for_timeout(1800)
    career = pg.evaluate("() => document.querySelectorAll('.tl-careerdot').length")
    check("giugiaro career drawn", career > 30, f"{career} cars")
    pg.screenshot(path=OUT+"shot_timeline_giugiaro.png")
    # scrub
    pg.evaluate("() => CarWebTimeline._setYear ? null : null")
    pg.select_option("#tl-designer", "")
    pg.wait_for_timeout(300)
    pg.screenshot(path=OUT+"shot_timeline.png")

    # ---------- performance ----------
    pg.click("[data-view=graph]")
    pg.wait_for_timeout(500)
    ms = pg.evaluate("""() => new Promise(res => {
      const cw = CarWeb; let i=0; const t0 = performance.now();
      function f(){ cw && window.dispatchEvent(new Event('resize')); i++;
        if(i<40) requestAnimationFrame(f); else res((performance.now()-t0)/40); }
      requestAnimationFrame(f);
    })""")
    check("frame budget (full redraw)", ms < 26, f"{ms:.1f} ms/frame")
    pg.screenshot(path=OUT+"shot_graph_tuned.png")

    js_errors = [e for e in errs if "Wikipedia" not in e]
    check("no js errors", not js_errors, str(js_errors[:3]))
    b.close()

print("\n" + ("ALL GREEN" if not fails else f"{len(fails)} FAILURES: {fails}"))
sys.exit(1 if fails else 0)
