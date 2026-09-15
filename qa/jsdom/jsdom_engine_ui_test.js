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
  const heads = [...box.querySelectorAll("h4")].map(h => h.textContent);
  check("the car's card lists its engines", heads.indexOf("Engines") >= 0, heads.join(", "));
  const rows = [...box.querySelectorAll("button")].map(b => b.textContent);
  check("...by name", rows.some(r => /M256/.test(r)), rows.slice(0, 4).join(" | "));
  check("...saying which have not been read yet",
        rows.some(r => /not read yet/.test(r)), rows.slice(0, 2).join(" | "));
  check("nothing was fetched to draw that", fetched.length === 0, fetched.join(", "));
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
