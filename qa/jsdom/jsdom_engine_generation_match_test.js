// Real user reports:
//
// 3. "if a car is found for the first time from searching for a particular
//    engine, it should also be checked whether of not the car being matched is
//    a nameplate (unless it does this already?), and then match them to the
//    generation corresponding to it."
// 8. "why is the Oldsmobile LF9 engine linked to the entire Buick Riviera
//    nameplate and not a specific generation from the riviera nameplate? There
//    should be enough information about the year of the engine produced.
//    Actually, when I look at this engine in the wikipedia, it even says it's
//    for the '1981-1985 Buick Riviera'."
//
// Both hang on the same thing. When the LF9 was read, the Riviera was one
// undivided model -- there was no generation to connect to, and the nameplate
// was the only honest answer. The car is queued for its own check; what was
// missing is what happens when that check comes back. The engine has to move
// down onto the generation the years point at, and the nameplate-level line
// has to go, or the same fact is drawn twice.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const CACHE = path.resolve(__dirname, "..", "wiki_cache");
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
const OLDS = fs.readFileSync(path.join(CACHE, "Oldsmobile_Diesel_engine.wikitext"), "utf-8");

// The Riviera as the graph really had it: one plain model, no generations.
const RIV = "m-testriv-riviera";
const FAM = "fam-testriv-riviera";
const G5 = "m-testriv-riviera-fifth", G6 = "m-testriv-riviera-sixth", G7 = "m-testriv-riviera-seventh";

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
const ARTICLES = { "Oldsmobile Diesel engine": OLDS };
window.fetch = (u, o) => {
  const s = String(u);
  if (s === "/api/llm-families" && o && o.method === "POST")
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  const m = s.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    const wt = ARTICLES[title];
    if (!wt) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-testriv", type: "make", label: "Buick", year: 1899 };
    D.nodes.push(mk, { id: RIV, type: "model", label: "Riviera", make: "Buick", year: 1963,
                       end: null, wp: "Buick Riviera", designers: [], engineers: [] });
    D.links.push({ source: RIV, target: mk.id, type: "made" });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;
const idOf = v => (v && v.id) || v;
const fittedTo = id => DATA.links.filter(l => l.type === "fitted" && !l.retired &&
  (idOf(l.source) === id || idOf(l.target) === id));

(async () => {
  // ---------- reading the engine while the car is one undivided model ----------
  const before = DATA.nodes.length, lbefore = DATA.links.length;
  const r = await LF.checkEngine("Oldsmobile Diesel engine", DATA.nodes, DATA.links,
                                 { cascade: false, mintCars: false });
  cw.spliceIntoIndexes(before, lbefore);
  check("(precondition) the engine was read", r.status === "confirmed", r.status);
  check("it connects to the Riviera, which is all there is to connect to",
        fittedTo(RIV).length === 1, fittedTo(RIV).length);
  const lf9 = DATA.nodes.find(n => n.type === "enginevar" && /LF9/.test(n.label));
  check("...from the LF9, the variant whose section names it",
        !!lf9 && fittedTo(RIV).some(l => idOf(l.source) === lf9.id || idOf(l.target) === lf9.id),
        lf9 && lf9.label);
  check("...carrying the years its article stated",
        fittedTo(RIV).some(l => l.yearStart === 1981 && l.yearEnd === 1985),
        JSON.stringify(fittedTo(RIV).map(l => [l.yearStart, l.yearEnd])));

  // ---------- the car is then split into generations ----------
  // What the nameplate check does: the model becomes a family and its
  // generations are minted. Done by hand here so the test is about what
  // happens NEXT, not about the split.
  const riv = cw.byId.get(RIV);
  riv.type = "family";
  riv.generations = [G5, G6, G7];
  [[G5, "Riviera Fifth generation", 1971, 1976],
   [G6, "Riviera Sixth generation", 1979, 1985],
   [G7, "Riviera Seventh generation", 1986, 1993]].forEach(([id, label, y, e]) => {
    DATA.nodes.push({ id, type: "model", label, make: "Buick", familyOf: RIV,
                      year: y, end: e, wp: "Buick Riviera", designers: [], engineers: [] });
    DATA.links.push({ source: RIV, target: id, type: "generation" });
  });
  cw.spliceIntoIndexes(DATA.nodes.length - 3, DATA.links.length - 3);

  const res = LF.restitchEngineEdges(DATA.nodes, DATA.links);
  check("re-placing the engine's edges moves it down onto a generation",
        fittedTo(G6).length === 1, JSON.stringify({ g5: fittedTo(G5).length, g6: fittedTo(G6).length, g7: fittedTo(G7).length }));
  check("...the one whose years cover the ones the article stated",
        fittedTo(G6).some(l => l.yearStart === 1981), JSON.stringify(fittedTo(G6).map(l => [l.yearStart, l.yearEnd])));
  check("...and not the generations it was never in",
        fittedTo(G5).length === 0 && fittedTo(G7).length === 0,
        fittedTo(G5).length + "/" + fittedTo(G7).length);
  check("the nameplate-level line is gone, so the fact is drawn once",
        fittedTo(RIV).length === 0, JSON.stringify(fittedTo(RIV).map(l => idOf(l.source) + "->" + idOf(l.target))));
  check("...and that is what it reports doing", res.dropped >= 1, JSON.stringify(res));

  // Running it again changes nothing: it is a re-placement, not an append.
  const linksBefore = DATA.links.filter(l => l.type === "fitted" && !l.retired).length;
  LF.restitchEngineEdges(DATA.nodes, DATA.links);
  check("re-placing twice is the same as once",
        DATA.links.filter(l => l.type === "fitted" && !l.retired).length === linksBefore,
        linksBefore + " -> " + DATA.links.filter(l => l.type === "fitted" && !l.retired).length);

  // ---------- 3: a car found from an engine gets checked for generations ----------
  const src = fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8");
  check("a plain model an engine named is queued for its own nameplate check",
        /function scheduleEngineCascade[\s\S]{0,700}?if \(car\.type !== "model" \|\| car\.familyOf\) continue;[\s\S]{0,200}?schedulePartnerCheck\(car, nodes, engineId\);/.test(src));
  const appSrc = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
  check("...and when that check splits it, the engines are re-placed there and then",
        /scanEnginesLive\(n\);\s*\n[\s\S]{0,400}?restitchEnginesLive\(\);/.test(appSrc));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
