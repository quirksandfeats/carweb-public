// Real bug report: "I ran an llm check on the mercedes E class... there didn't
// appear to be any information in the terminal on serve.py, nor was there any
// indication that there was any powertrain research performed (and no info on
// the info card of a particular generation of a nameplate, or even model).
// Maybe I'm doing something wrong but even when clicking the 'powertrain' tab
// it says nothing is scanned yet."
//
// Not a plumbing failure -- the wrong article. Engines were read off whichever
// page the generation CHECK fetched, and for a nameplate that is the umbrella
// page. The real Mercedes-Benz E-Class article has no engine field anywhere in
// it; its W213 generation article names nine. So the nameplate most worth
// asking about found nothing, every time, and reported that by staying silent.
//
// Made worse by a second thing: a minted generation inherits the NAMEPLATE's
// wp (see applyFamilyOverride), so even fetching "the generation's article"
// would have fetched the umbrella a second time.
//
// Both articles here are the real ones.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const CACHE = path.join(ROOT, "qa", "wiki_cache");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ECLASS = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_E-Class.wikitext"), "utf-8");
const W213 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_E-Class__W213_.wikitext"), "utf-8");

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });

const ARTICLES = {
  "Mercedes-Benz E-Class": ECLASS,
  "Mercedes-Benz E-Class (W213)": W213,
};
const asked = [];
window.fetch = (url) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    asked.push(title);
    const wt = ARTICLES[title];
    if (!wt) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
const FAM = "fam-mb-e-class", G213 = "m-mb-e-w213", G212 = "m-mb-e-w212";
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-mb", type: "make", label: "Mercedes-Benz", year: 1926 };
    const fam = { id: FAM, type: "family", label: "E-Class", make: "Mercedes-Benz",
                  wp: "Mercedes-Benz E-Class", generations: [G212, G213], designers: [], engineers: [] };
    D.nodes.push(mk, fam);
    D.links.push({ source: FAM, target: mk.id, type: "made" });
    // Exactly as applyFamilyOverride mints them: the generation inherits the
    // NAMEPLATE's article, which is the trap.
    [[G212, "E-Class (W212)"], [G213, "E-Class (W213)"]].forEach(([id, label]) => {
      D.nodes.push({ id, type: "model", label, make: "Mercedes-Benz", familyOf: FAM,
                     wp: "Mercedes-Benz E-Class", designers: [], engineers: [] });
      D.links.push({ source: FAM, target: id, type: "generation" });
    });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- 1. the article that started this ----------
{
  check("the real E-Class umbrella article names no engine at all",
        LF.engineMentions(ECLASS).length === 0, LF.engineMentions(ECLASS).length);
  // Eleven entries over nine distinct engines: the W213 runs two M264
  // variants and two M274s, and one line per engine is what tells them apart.
  check("...while its W213 generation article names eleven",
        LF.engineMentions(W213).length === 11, LF.engineMentions(W213).length);
  check("...over nine distinct engines",
        new Set(LF.engineMentions(W213).map(x => x.title)).size === 9,
        new Set(LF.engineMentions(W213).map(x => x.title)).size);
}

(async () => {
  // ---------- 2. which article a generation's engines come from ----------
  {
    const fam = cw.byId.get(FAM), g = cw.byId.get(G213);
    check("(precondition) the generation inherited the nameplate's article",
          g.wp === "Mercedes-Benz E-Class", g.wp);
    const title = LF.engineArticleFor(g, fam, ECLASS);
    check("the scan goes to the generation's OWN article instead",
          title === "Mercedes-Benz E-Class (W213)", title);
    const famTitle = LF.engineArticleFor(fam, fam, ECLASS);
    check("...and a plain car reads its own", famTitle === "Mercedes-Benz E-Class", famTitle);
  }

  // ---------- 3. checking the nameplate finds them ----------
  {
    const fam = cw.byId.get(FAM);
    const before = DATA.nodes.filter(n => n.type === "engine").length;
    const r = await LF.scanEnginesFor(fam, DATA.nodes, DATA.links);
    check("both generations were read", r.scanned >= 1, JSON.stringify(r));
    check("engines came out of it", r.engines === 9, r.engines);
    check("...connected to the generation that ran them", r.fitted === 9, r.fitted);
    check("...as real nodes", DATA.nodes.filter(n => n.type === "engine").length === before + 9,
          DATA.nodes.filter(n => n.type === "engine").length - before);
    check("the W212, whose article is not here, is skipped rather than guessed at",
          r.skipped >= 1, r.skipped);

    const fitted = DATA.links.filter(l => l.type === "fitted");
    check("the connections hang off the GENERATION, not the nameplate",
          fitted.every(l => l.target === G213), fitted.map(l => l.target).join(","));
    check("...which is what puts them on that generation's card, where the user "
          + "looked and found nothing",
          fitted.length > 0 && fitted.every(l => l.target !== FAM));
  }

  // ---------- 4. the card and the view ----------
  {
    const g = cw.byId.get(G213);
    cw.openDetail(g);
    const box = window.document.querySelector(".dt-power");
    check("the generation's card lists its engines",
          /Engines/.test(box.textContent) && /M256/.test(box.textContent),
          box.textContent.slice(0, 90));

    const c = cw.powertrainCounts();
    check("the Powertrain tab no longer says nothing is scanned",
          c.engines === 9 && c.cars >= 1, JSON.stringify(c));
    cw.switchView("power");
    check("...and its bar says so",
          /9 engines/.test(window.document.getElementById("pt-counts").textContent),
          window.document.getElementById("pt-counts").textContent);
  }

  // ---------- 5. done once ----------
  {
    const fam = cw.byId.get(FAM);
    const askedBefore = asked.length;
    const r = await LF.scanEnginesFor(fam, DATA.nodes, DATA.links);
    check("re-checking the same nameplate reads nothing again",
          r.scanned === 0 && asked.length === askedBefore,
          r.scanned + " scanned, fetched: " + asked.slice(askedBefore).join(" | "));
    check("...and adds no duplicate engines", r.engines === 0, r.engines);
    check("it is recorded per car, so a reload does not repeat the work",
          !!LF.engineScanEntryFor(G213), LF.engineScanEntryFor(G213) &&
          LF.engineScanEntryFor(G213).sourceTitle);
  }

  // ---------- 6. ...but a deliberate re-check really does do it again ----------
  // Second half of the same bug report: "sometimes when doing an LLM re-check,
  // it doesn't actually do a full re-check. For example, I tried to do so with
  // the E Class nameplate that didn't have the new engine data, so running the
  // llm re-check, I hoped it would be there. However, it wasn't."
  //
  // Section 5's "reads nothing again" is what made it a no-op: every
  // generation already scanned is skipped, and a generation whose article was
  // briefly unreachable had a miss recorded that is deliberately sticky. The
  // re-check is the escape hatch, so it has to drop those records first.
  {
    const fam = cw.byId.get(FAM);
    check("(precondition) the W212's miss is on file and would be skipped forever",
          LF.engineScanEntryFor(G212) && LF.engineScanEntryFor(G212).status === "unreadable",
          LF.engineScanEntryFor(G212) && LF.engineScanEntryFor(G212).status);

    const cleared = LF.clearEngineScansFor(fam, [cw.byId.get(G212), cw.byId.get(G213)]);
    check("a re-check forgets what every generation's scan concluded", cleared === 3, cleared);
    check("...including the sticky miss", !LF.engineScanEntryFor(G212));

    const askedBefore = asked.length;
    const r = await LF.scanEnginesFor(fam, DATA.nodes, DATA.links);
    check("...so the articles are genuinely read again", r.scanned >= 2 && asked.length > askedBefore,
          r.scanned + " scanned, " + (asked.length - askedBefore) + " fetched");
    check("...and the engines are still found", LF.engineScanEntryFor(G213).engines.length === 11,
          LF.engineScanEntryFor(G213).engines.length);
    check("...without duplicating a single node", DATA.nodes.filter(n => n.type === "engine").length === 9,
          DATA.nodes.filter(n => n.type === "engine").length);
    check("...or a single connection", DATA.links.filter(l => l.type === "fitted").length === 9,
          DATA.links.filter(l => l.type === "fitted").length);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
