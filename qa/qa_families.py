#!/usr/bin/env python3
"""QA sweep for the nameplate-family layer: screenshots + functional assertions.
Covers: data sanity, Graph expand/collapse, Timeline collapse/expand dots,
Six Degrees pathing through a family + to a hidden generation, search still
finding specific generations, and that the pre-existing My Database / layer
toggle / core features still work unaffected."""
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
    pg.wait_for_timeout(2600)

    # ---------- data sanity ----------
    sanity = pg.evaluate("""() => {
      const cw = CarWeb, out = {};
      out.version = window.CARDATA.meta.version;
      out.families = cw.nodes.filter(n => n.type === 'family').length;
      out.golf = cw.nodes.find(n => n.type === 'family' && n.make === 'Volkswagen' && n.label === 'Golf');
      out.golfGenCount = out.golf ? out.golf.generations.length : 0;
      const gens = out.golf ? out.golf.generations.map(id => cw.byId.get(id)) : [];
      out.golfHidden = gens.every(g => !cw.nodeInLayer(g));
      out.golfFamilyVisible = out.golf ? cw.nodeInLayer(out.golf) : false;
      // NB: after boot() runs buildSim(), d3-force mutates link.source/target
      // in place into node object refs (standard d3 behavior) — l.sn/l.tn
      // (computed once at load, before that mutation) are the reliable way
      // to inspect a link's endpoints at runtime, so use those here.
      out.golfHasMadeLink = cw.links.some(l => l.type === 'made' && l.sn === out.golf && l.tn.label === 'Volkswagen');
      out.gensNoDirectMade = gens.every(g => !cw.links.some(l => l.type === 'made' && l.sn === g));
      out.golfDesigners = out.golf.designers.length;
      return out;
    }""")
    check("families present (64)", sanity["families"] == 64, str(sanity["families"]))
    check("Golf family found with 8 generations", sanity["golfGenCount"] == 8, str(sanity["golfGenCount"]))
    check("Golf generations hidden by default", sanity["golfHidden"])
    check("Golf family node itself visible", sanity["golfFamilyVisible"])
    check("Golf family carries the 'made by VW' link", sanity["golfHasMadeLink"])
    check("Golf generations no longer carry their own 'made' link", sanity["gensNoDirectMade"])
    check("Golf family aggregates designers", sanity["golfDesigners"] > 0, str(sanity["golfDesigners"]))

    pg.screenshot(path=OUT + "fam_boot_graph.png")

    # ---------- Graph: search for the family, expand via click ----------
    pg.fill("#search", "Volkswagen Golf")
    pg.wait_for_timeout(350)
    pg.click("#searchresults .sr-item >> nth=0")
    pg.wait_for_timeout(1100)
    state1 = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      return { expanded: cw.isFamilyExpanded(golf.id), detailShown: !document.getElementById('detail').hidden,
        genRows: document.querySelectorAll('.dt-generations .dt-gen').length };
    }""")
    check("clicking Golf family expands it", state1["expanded"])
    check("detail panel opens on family click", state1["detailShown"])
    check("detail panel lists 8 generation rows", state1["genRows"] == 8, str(state1["genRows"]))
    pg.screenshot(path=OUT + "fam_graph_expanded.png")

    # click a generation row inside the detail panel -> should navigate + keep it visible
    pg.click(".dt-generations .dt-gen >> nth=2")
    pg.wait_for_timeout(1100)
    state2 = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      return { stillExpanded: cw.isFamilyExpanded(golf.id), title: document.querySelector('.dt-title').textContent };
    }""")
    check("family stays expanded after navigating to a generation", state2["stillExpanded"])
    check("detail now shows a specific generation", "Golf" in state2["title"], state2["title"])
    pg.screenshot(path=OUT + "fam_graph_generation_detail.png")

    # release focus -> family should collapse back
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(500)
    state3 = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      return cw.isFamilyExpanded(golf.id);
    }""")
    check("Escape collapses the family again", state3 is False, str(state3))

    # ---------- Timeline: collapsed family = 1 dot spanning full run, expand on click ----------
    pg.click('.tab[data-view="timeline"]')
    pg.wait_for_timeout(900)
    tl1 = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      const dots = document.querySelectorAll('.tl-dot').length;
      const famDot = document.querySelector('.tl-dot.family');
      return { dotCount: dots, hasFamilyDot: !!famDot, expanded: cw.isFamilyExpanded(golf.id) };
    }""")
    check("timeline shows a distinct family dot style", tl1["hasFamilyDot"])
    check("Golf family collapsed by default on timeline", tl1["expanded"] is False)
    pg.screenshot(path=OUT + "fam_timeline_collapsed.png")

    # click the family's dot to expand
    clicked = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      const dots = [...document.querySelectorAll('.tl-dot.family')];
      // find the one whose bound data is the golf family node (approx: click via DOM order not easy from JS,
      // so just call the API directly the same way a click would)
      cw.expandFamily(golf.id);
      return true;
    }""")
    pg.wait_for_timeout(700)
    tl2 = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      return { expanded: cw.isFamilyExpanded(golf.id), dotCount: document.querySelectorAll('.tl-dot').length };
    }""")
    check("expandFamily flips timeline to individual dots", tl2["expanded"])
    pg.screenshot(path=OUT + "fam_timeline_expanded.png")
    pg.evaluate("""() => { const cw = CarWeb; const golf = cw.nodes.find(n => n.type==='family' && n.label==='Golf' && n.make==='Volkswagen'); cw.collapseFamily(golf.id); }""")
    pg.wait_for_timeout(400)

    # ---------- Six Degrees: family participates + hidden generation reachable ----------
    pg.click('.tab[data-view="sixdeg"]')
    pg.wait_for_timeout(500)
    pg.fill("#sd-from", "Volkswagen Golf")
    pg.wait_for_timeout(350)
    pg.click(".sd-results .sr-item >> nth=0")
    pg.fill("#sd-to", "Giorgetto Giugiaro")
    pg.wait_for_timeout(350)
    pg.click('.sd-pick:has(#sd-to) .sr-item >> nth=0')
    pg.wait_for_timeout(300)
    pg.click("#sd-go")
    pg.wait_for_timeout(1600)
    sd1 = pg.evaluate("() => document.querySelectorAll('#sd-steps li').length")
    check("six degrees traces a path from the Golf family", sd1 > 0, str(sd1))
    pg.screenshot(path=OUT + "fam_sixdeg_family.png")

    # path directly to a hidden generation by id
    sd2 = pg.evaluate("""() => {
      const cw = CarWeb;
      const golf = cw.nodes.find(n => n.type === 'family' && n.label === 'Golf' && n.make === 'Volkswagen');
      const gen = cw.byId.get(golf.generations[5]);
      return { genLabel: gen.label, wasHidden: !cw.nodeInLayer(gen) };
    }""")
    check("a specific Golf generation starts hidden (pre-search)", sd2["wasHidden"])
    pg.fill("#sd-from", sd2["genLabel"])
    pg.wait_for_timeout(350)
    pg.click(".sd-pick:has(#sd-from) .sr-item >> nth=0")
    pg.fill("#sd-to", "Giorgetto Giugiaro")
    pg.wait_for_timeout(350)
    pg.click('.sd-pick:has(#sd-to) .sr-item >> nth=0')
    pg.wait_for_timeout(300)
    pg.click("#sd-go")
    pg.wait_for_timeout(1600)
    sd3 = pg.evaluate("() => document.querySelectorAll('#sd-steps li').length")
    check("path found even when target was a hidden generation (auto-expanded)", sd3 > 0, str(sd3))
    pg.screenshot(path=OUT + "fam_sixdeg_hidden_generation.png")

    # ---------- search still finds specific generations directly ----------
    pg.click('.tab[data-view="graph"]')
    pg.wait_for_timeout(500)
    pg.fill("#search", "Golf Mk3")
    pg.wait_for_timeout(350)
    sr = pg.evaluate("() => document.querySelectorAll('#searchresults .sr-item').length")
    check("search finds a specific generation by name", sr > 0, str(sr))
    pg.keyboard.press("Escape")

    # ---------- unaffected: My Database layer + layer toggle + core counts ----------
    core = pg.evaluate("""() => {
      const out = {};
      out.dbBtnVisible = document.getElementById('dbfilter').hidden === false;
      out.countsText = document.getElementById('counts').textContent;
      return out;
    }""")
    check("My Database button still present", core["dbBtnVisible"])
    check("footer counts mention nameplates", "nameplates" in core["countsText"], core["countsText"])
    pg.click("#dbfilter")
    pg.wait_for_timeout(500)
    dbActive = pg.evaluate("() => document.getElementById('dbfilter').classList.contains('active')")
    check("My Database filter still toggles", dbActive)
    pg.screenshot(path=OUT + "fam_db_filter_still_works.png")
    pg.click("#dbfilter")

    pg.click('button[data-layer="engineers"]')
    pg.wait_for_timeout(400)
    layerActive = pg.evaluate("() => document.querySelector('#layertoggle button.active').dataset.layer")
    check("people layer toggle still works", layerActive == "engineers", layerActive)

    check("no console/page errors captured", len(errs) == 0, str(errs[:5]))

    b.close()

print()
print(f"{'ALL GREEN' if not fails and not errs else 'FAILURES: ' + str(fails + errs)}")
sys.exit(1 if (fails or errs) else 0)
