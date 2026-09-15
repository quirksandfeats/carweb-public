// The way in. Everything before this was data with no door on it: nothing
// called checkEngine, and an engine node could not be reached from any card.
//
// Real user request: "The user can also now search for individual engines
// (or, they can 'add a new engine' to the graph), and have the LLM look
// through it." Plus the other direction -- a car that was checked lists the
// engines it ran, and each is a way into the powertrain view.
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

const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");
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

// Wikipedia, served from the cache. Anything else 404s, which is what makes
// "it only reaches the network when you ask it to" checkable.
const ARTICLES = { "Mercedes-Benz M256 engine": M256 };
const fetched = [];
window.fetch = (url) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    fetched.push(title);
    const wt = ARTICLES[title];
    if (!wt) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
let posted = 0;
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;
const doc = window.document;

// ---------- 1. the card has somewhere to put this ----------
{
  check("the detail panel has a powertrain block", !!doc.querySelector(".dt-power"));
  check("...and the tools menu has an Add Engine item", !!doc.getElementById("addenginebtn"));
  check("...shown, because this session has a local model",
        doc.getElementById("addenginebtn").hidden === false);
}

// ---------- 2. a car that ran engines says so ----------
{
  const car = DATA.nodes.find(n => n.type === "model" && n.make === "Mercedes-Benz") ||
              DATA.nodes.find(n => n.type === "model");
  // Through the same path a real check takes: the mentions are stored on the
  // car's entry, then recordEnginesLive puts them in the graph AND indexes
  // them, which is what every card below depends on.
  LF.__store = null;
  window.LLM_FAMILIES.families[car.id] = { status: "none", engines: LF.engineMentions(W213) };
  cw.recordEnginesLive();
  cw.openDetail(car);
  const box = doc.querySelector(".dt-power");
  // Folded away by default on the Graph tab, per "I want them to be
  // contained in a dropdown within the info card, not expanded by default".
  const fold = box.querySelector("details.dt-power-fold");
  check("the car's card lists its engines", !!fold && /^Engines \(\d+\)$/.test(
        fold.querySelector("summary").textContent),
        fold && fold.querySelector("summary").textContent);
  check("...folded shut, since this is the Graph tab", !!fold && !fold.open);
  const rows = [...box.querySelectorAll("button")].map(b => b.textContent);
  check("...by name", rows.some(r => /M256/.test(r)), rows.slice(0, 4).join(" | "));
  check("...saying which have not been read yet",
        rows.some(r => /not read yet/.test(r)), rows.slice(0, 2).join(" | "));
  check("nothing was fetched to draw that", fetched.length === 0, fetched.join(", "));

  // Real bug report: "In the Powertrain Tab, for a particular car, you can
  // see information repeated. the 'fitted to' and the 'linked to' contain
  // exactly the same information. I only need it once." Same on the Graph
  // tab, between "engines" and "linked to". The fitted edges had no verb in
  // the verbs table, so the generic connections list fell through to its
  // "linked to" fallback and printed the engine rows a second time.
  const connHeads = [...doc.querySelectorAll(".dt-connections h4")].map(h => h.textContent);
  const connRows = [...doc.querySelectorAll(".dt-connections button")].map(b => b.textContent);
  check("the engines are not repeated as a second 'linked to' list",
        connHeads.indexOf("linked to") < 0, connHeads.join(", "));
  check("...nor do the engine rows appear there at all",
        !connRows.some(r => /M256|M264|M254/.test(r)), connRows.slice(0, 5).join(" | "));

  // Open on the Powertrain tab, where engines are the reason for looking.
  cw.switchView("power");
  cw.openDetail(car);
  const foldP = doc.querySelector(".dt-power details.dt-power-fold");
  check("...but open by default on the Powertrain tab", !!foldP && foldP.open);
  cw.switchView("graph");
}

// ---------- 2b. the engine's own card ----------
// Real bug report: an engine card reading "ENGINE · NOT READ YET" directly
// above its own displacement and a list of seventeen cars, and a meta line
// saying "· 0 cars in the web" while that list sat under it. Both came from
// an engine falling through to a branch written for a person.
{
  const eng = DATA.nodes.find(n => n.type === "engine");
  cw.openDetail(eng);
  const meta = doc.querySelector(".dt-meta") || doc.querySelector("#dt-meta");
  const metaText = meta ? meta.textContent : "";
  // "in the web" stays: it is what separates this number -- cars actually in
  // the graph -- from the card's own "FITTED TO 17 CARS", which counts what
  // the article named whether or not any of them is here.
  check("an engine's meta line counts the cars it is fitted to, not credits",
        /fitted to [1-9]\d* cars? in the web/.test(metaText), metaText);
  check("...and does not claim 0 cars while listing them",
        !/·\s*0 cars in the web/.test(metaText), metaText);
  const specsEls = doc.querySelectorAll(".dt-power .dt-power-specs");
  check("the spec line is printed once, in the meta row, not twice",
        specsEls.length === 0, specsEls.length);
}

// ---------- 2c. the Powertrain canvas actually has room to draw ----------
// Real bug report, with a screenshot: the tab read "47 engines · 0 variants ·
// 25 cars · 110 fitted" over a completely blank page. #view-power set
// position:relative, which overrode .view's own "position:absolute; inset:0"
// -- so the section collapsed to the height of its bar and #ptcanvas, at
// inset:0 inside it, became a ~40px strip behind that bar. jsdom does no
// layout, so this is checked where the bug actually lived.
{
  const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
  const rule = (css.match(/#view-power\s*\{([^}]*)\}/) || [])[1] || "";
  check("the powertrain view is positioned to fill its container",
        /position\s*:\s*absolute/.test(rule) && /inset\s*:\s*0/.test(rule), rule.trim());
  check("...and the canvas fills the view", /#ptcanvas\s*\{[^}]*inset\s*:\s*0/.test(css));
}

// ---------- 3. an engine's own card ----------
{
  const eng = DATA.nodes.find(n => n.type === "engine" && n.label === "M256");
  check("the engine is reachable as a node", !!eng);
  check("...and search finds it", cw.searchAll("M256").some(n => n === eng),
        cw.searchAll("M256").map(n => n.label).join(", "));

  cw.openDetail(eng);
  const kicker = doc.querySelector(".dt-kicker").textContent;
  check("its card says what it is, not that it is a person",
        /engine/.test(kicker) && !/designer|engineer ·/.test(kicker), kicker);
  const box = doc.querySelector(".dt-power");
  check("...and offers to read its article",
        [...box.querySelectorAll("button")].some(b => /Read this engine/.test(b.textContent)),
        [...box.querySelectorAll("button")].map(b => b.textContent).join(" | "));
  check("...explaining why there is nothing else to show yet",
        /Nothing has read its own article/.test(box.textContent), box.textContent.slice(0, 80));
}

// ---------- 4. going to an engine takes you to its view ----------
{
  const eng = DATA.nodes.find(n => n.type === "engine" && n.label === "M256");
  cw.switchView("graph");
  cw.goto(eng.id);
  check("clicking through to an engine switches to the Powertrain view",
        doc.getElementById("view-power").classList.contains("active"));
  check("...rather than flying the main graph to an empty patch of canvas",
        [...(cw.graphFocusSet() || [])].length === 0);
}

// ---------- 5. reading it ----------
(async () => {
  const eng = DATA.nodes.find(n => n.type === "engine" && n.label === "M256");
  check("(precondition) it has no variants yet", (eng.variants || []).length === 0);
  const linksBefore = DATA.links.filter(l => l.type === "fitted").length;

  cw.scanEngine("Mercedes-Benz M256 engine", null);
  for (let i = 0; i < 120 && (eng.variants || []).length === 0; i++) {
    await new Promise(r => setTimeout(r, 25));
  }

  check("the article was fetched, once asked", fetched.indexOf("Mercedes-Benz M256 engine") >= 0,
        fetched.join(", "));
  check("the engine gained its variants", (eng.variants || []).length === 3, (eng.variants || []).length);
  check("...its spec card", eng.configuration === "Straight-six", eng.configuration);
  check("...and more cars than the one that mentioned it",
        DATA.links.filter(l => l.type === "fitted").length > linksBefore,
        DATA.links.filter(l => l.type === "fitted").length + " vs " + linksBefore);
  check("it is recorded, so a reload does not have to read it again",
        !!LF.engineEntryFor(eng.id) && LF.engineEntryFor(eng.id).status === "confirmed",
        LF.engineEntryFor(eng.id) && LF.engineEntryFor(eng.id).status);

  cw.openDetail(eng);
  const box = doc.querySelector(".dt-power");
  const heads = [...box.querySelectorAll("h4")].map(h => h.textContent);
  check("its card now lists the variants", heads.indexOf("Variants") >= 0, heads.join(", "));
  check("...and the cars it went into", heads.some(h => /Fitted to \d+ cars?/.test(h)), heads.join(", "));
  // The applications belong to the variants, so an engine that did not roll
  // them up reported "Fitted to 1 car" while its three variants held 19.
  const fittedHead = heads.find(h => /^Fitted to/.test(h));
  check("...counted across its variants, not just its own edges",
        /Fitted to 1[0-9] cars/.test(fittedHead || ""), fittedHead);
  check("...each saying which variant it was",
        [...box.querySelectorAll("button")].some(b => /DEH LA/.test(b.textContent)),
        [...box.querySelectorAll("button")].map(b => b.textContent).slice(2, 5).join(" | "));
  check("...with the offer now reading as a re-read",
        [...box.querySelectorAll("button")].some(b => /Read it again/.test(b.textContent)));

  // And the main graph still knows nothing about any of it.
  check("the main graph never saw an engine",
        DATA.nodes.filter(n => cw.nodeInLayer(n) && cw.isPowertrain(n)).length === 0);

  const variant = DATA.nodes.find(n => n.type === "enginevar");
  cw.openDetail(variant);
  const vbox = doc.querySelector(".dt-power");
  check("a variant's card points back at its engine",
        /Engine/.test(vbox.textContent) &&
        [...vbox.querySelectorAll("button")].some(b => /M256/.test(b.textContent)),
        [...vbox.querySelectorAll("button")].map(b => b.textContent).slice(0, 3).join(" | "));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
