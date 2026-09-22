#!/usr/bin/env python3
"""QA sweep for two additions: the Graph 'None' people-layer option, and the
Timeline 'follow a nameplate' picker."""
from playwright.sync_api import sync_playwright
import os, sys

BASE = "http://localhost:8077/index.html"
# Output/asset paths resolve relative to this file, so the script runs from
# anywhere and on any machine.
_QA_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_DIR = os.path.join(_QA_DIR, "..", "app")
OUT = _QA_DIR + os.sep
fails, errs = [], []

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, extra)
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error"
          and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    pg.goto(BASE, wait_until="domcontentloaded", timeout=20000)
    pg.wait_for_function("() => window.__carwebReady === true", timeout=180000)  # see index.html\'s loader

    # ---------- Graph: None layer option ----------
    hasNoneBtn = pg.evaluate("() => !!document.querySelector('#layertoggle button[data-layer=\"none\"]')")
    check("None button exists in layer toggle", hasNoneBtn)
    pg.click('#layertoggle button[data-layer="none"]')
    pg.wait_for_timeout(400)
    state = pg.evaluate("""() => {
      const cw = CarWeb;
      const anyPersonVisible = cw.nodes.some(n => n.type === 'person' && cw.nodeInLayer(n));
      const activeBtn = document.querySelector('#layertoggle button.active').dataset.layer;
      return { anyPersonVisible, activeBtn, currentLayer: cw.layer() };
    }""")
    check("None hides every person node", state["anyPersonVisible"] is False)
    check("None button becomes active", state["activeBtn"] == "none", state["activeBtn"])
    pg.screenshot(path=OUT + "layer_none.png")

    # switch back to designers, confirm people reappear
    pg.click('#layertoggle button[data-layer="designers"]')
    pg.wait_for_timeout(400)
    back = pg.evaluate("() => CarWeb.nodes.some(n => n.type === 'person' && CarWeb.nodeInLayer(n))")
    check("switching back to Designers restores people", back)

    # ---------- Timeline: follow a nameplate ----------
    pg.click('.tab[data-view="timeline"]')
    pg.wait_for_timeout(900)
    opts = pg.evaluate("""() => {
      const sel = document.getElementById('tl-designer');
      const groups = [...sel.querySelectorAll('optgroup')].map(g => g.label);
      const famOpt = [...sel.querySelectorAll('option')].find(o => o.value.startsWith('f:') && o.textContent.includes('Golf'));
      return { groups, famOptValue: famOpt ? famOpt.value : null, famOptText: famOpt ? famOpt.textContent : null };
    }""")
    check("picker has People + Nameplates optgroups", "Nameplates" in opts["groups"] and any("eople" in g or "esigner" in g for g in opts["groups"]), str(opts["groups"]))
    check("Golf appears as a followable nameplate", opts["famOptValue"] is not None, str(opts["famOptText"]))

    pg.select_option("#tl-designer", opts["famOptValue"])
    pg.wait_for_timeout(700)
    followState = pg.evaluate("""() => {
      const cw = CarWeb;
      const famId = document.getElementById('tl-designer').value.slice(2);
      const fam = cw.byId.get(famId);
      return {
        expanded: cw.isFamilyExpanded(famId),
        careerLine: !!document.querySelector('.tl-career'),
        careerDots: document.querySelectorAll('.tl-careerdot').length,
        caption: document.getElementById('tl-caption').textContent,
        genCount: fam.generations.length,
      };
    }""")
    check("selecting the nameplate auto-expands its family", followState["expanded"])
    check("a career-style line is drawn through its generations", followState["careerLine"])
    check("career dots count matches generation count", followState["careerDots"] == followState["genCount"],
          f'{followState["careerDots"]} vs {followState["genCount"]}')
    check("caption mentions the nameplate", "Golf" in followState["caption"], followState["caption"])
    pg.screenshot(path=OUT + "timeline_follow_nameplate.png")

    # clearing follow should collapse the family back
    pg.select_option("#tl-designer", "")
    pg.wait_for_timeout(500)
    cleared = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      return { expanded: cw.isFamilyExpanded(golf.id), careerLine: !!document.querySelector('.tl-career') };
    }""")
    check("clearing follow collapses the family again", cleared["expanded"] is False)
    check("career line removed after clearing", cleared["careerLine"] is False)

    # follow a person still works too (regression)
    personVal = pg.evaluate("""() => {
      const opt = [...document.querySelectorAll('#tl-designer option')].find(o => o.value.startsWith('p:'));
      return opt.value;
    }""")
    pg.select_option("#tl-designer", personVal)
    pg.wait_for_timeout(700)
    personFollow = pg.evaluate("() => !!document.querySelector('.tl-career')")
    check("following a designer/engineer still works", personFollow)
    pg.screenshot(path=OUT + "timeline_follow_person_regression.png")

    check("no console/page errors captured", len(errs) == 0, str(errs[:5]))
    b.close()

print()
print(f"{'ALL GREEN' if not fails and not errs else 'FAILURES: ' + str(fails + errs)}")
sys.exit(1 if (fails or errs) else 0)
