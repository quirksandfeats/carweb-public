// Two duplicate reports, one cause each.
//
// 2. "there are a few duplicate engines that exist in the graph. For example,
//    M176 exists twice, once as an engine and another time as an enginevar.
//    the M176 was already researched under the Mercedes-Benz M176/M177/M178
//    engine, and also clearly has more info about it. In this case, there
//    should be some duplicate checking whenever a new engine is considered to
//    be added, as well as some automatic clean-up check every time a new
//    engine is added, similar to how it is done for a car. A similar issue
//    goes for the Duramax engine."
//
// 11. "there currently exists a 'Mercedes-Benz GLA X156', which is part of the
//     GLA nameplate and has lots of info associated with it. There also exists
//     a 'Mercedes-Benz GLA-Class (X156)', which displays as a separate model
//     but has no additional information. This should also be considered when
//     trying to introduce a new model into the graph."
//
// Both are the same shape: one thing reached by two names. For an engine the
// key is its article, for a car it is its chassis code.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
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

const FAM = "fam-testdup-gla", G1 = "m-testdup-gla-x156", G2 = "m-testdup-gla-h247";
const STRAY = "llm-related-testdup-gla-class-x156";
const CAR = "m-testdup-car";

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
window.fetch = (u, o) => {
  if (String(u) === "/api/llm-families" && o && o.method === "POST")
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  if (/[?&]page=/.test(String(u))) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-testdup", type: "make", label: "TestDup", year: 1900 };
    D.nodes.push(mk);
    D.nodes.push({ id: FAM, type: "family", label: "GLA", make: "TestDup", year: 2013,
                   generations: [G1, G2], designers: [], engineers: [] });
    D.nodes.push({ id: G1, type: "model", label: "GLA X156", make: "TestDup", familyOf: FAM,
                   year: 2013, end: 2019, designers: [], engineers: [] });
    D.nodes.push({ id: G2, type: "model", label: "GLA H247", make: "TestDup", familyOf: FAM,
                   year: 2019, end: null, designers: [], engineers: [] });
    // The stray: the same car, minted from a mention that spelled the
    // nameplate the way Wikipedia used to.
    D.nodes.push({ id: STRAY, type: "model", label: "GLA-Class (X156)", make: "TestDup",
                   year: null, end: null, designers: [], engineers: [], llmGenerated: true });
    D.nodes.push({ id: CAR, type: "model", label: "Roadster", make: "TestDup", year: 2020,
                   designers: [], engineers: [] });
    D.links.push({ source: FAM, target: mk.id, type: "made" },
                 { source: FAM, target: G1, type: "generation" },
                 { source: FAM, target: G2, type: "generation" },
                 { source: STRAY, target: mk.id, type: "made" },
                 { source: STRAY, target: CAR, type: "platform" });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- 11. the same car under two spellings ----------
{
  const stray = cw.byId.get(STRAY), gen = cw.byId.get(G1);
  check("the stray copy is folded into the generation it names",
        stray.retired && stray.supersededBy === G1, stray.retired + " / " + stray.supersededBy);
  const mineOnly = l => [l.source, l.target].map(v => (v && v.id) || v)
                          .some(id => String(id).indexOf("testdup") >= 0);
  check("...and what it knew comes with it",
        DATA.links.some(l => l.type === "platform" && !l.retired && mineOnly(l) &&
          ((l.source.id || l.source) === G1 || (l.target.id || l.target) === G1)),
        DATA.links.filter(l => l.type === "platform" && mineOnly(l)).map(l =>
          (l.source.id || l.source) + "->" + (l.target.id || l.target) + (l.retired ? " (retired)" : "")).join(", "));
  check("...the nameplate still has exactly its two generations",
        cw.byId.get(FAM).generations.filter(id => !cw.byId.get(id).retired).length === 2,
        cw.byId.get(FAM).generations.join(", "));
  check("...and the generation itself is untouched", !gen.retired && gen.label === "GLA X156", gen.label);
}
// A code that matches while the names do not is two different cars.
{
  const other = { id: "m-testdup-unrelated", type: "model", label: "Estate (X156)", make: "TestDup",
                  year: 2015, designers: [], engineers: [] };
  DATA.nodes.push(other);
  cw.spliceIntoIndexes(DATA.nodes.length - 1, DATA.links.length);
  LF.foldCodeDuplicateModels(DATA.nodes, DATA.links);
  check("a different nameplate that happens to share a code is left alone", !other.retired);
}

// ---------- 2. the same engine under two names ----------
{
  // Exactly the state in the real file: the article's own node, read, with
  // three variants -- and a second, empty node for one of its codes.
  const hub = { id: "eng-testdup-m176-m177-m178", type: "engine", label: "TestDup M176/M177/M178",
                wp: "TestDup M176/M177/M178 engine", variants: [] };
  DATA.nodes.push(hub);
  ["M176", "M177", "M178"].forEach(code => {
    const v = { id: "engv-testdup-" + code.toLowerCase(), type: "enginevar", label: code,
                engineOf: hub.id, wp: hub.wp };
    DATA.nodes.push(v); hub.variants.push(v.id);
    DATA.links.push({ source: hub.id, target: v.id, type: "enginevariant" });
  });
  const stray = { id: "eng-testdup-m177", type: "engine", label: "M177",
                  wp: "TestDup M176/M177/M178 engine", unresearched: true, variants: [] };
  DATA.nodes.push(stray);
  DATA.links.push({ source: stray.id, target: CAR, type: "fitted", fromCar: true });
  cw.spliceIntoIndexes(0, 0);

  const r = LF.autoMergeDuplicateEngines(DATA.nodes, DATA.links);
  check("an engine reached twice under one article is folded into one",
        r.merged === 1 && cw.byId.get("eng-testdup-m177").retired,
        JSON.stringify(r));
  check("...into the node that has the article behind it, not the empty one",
        !hub.retired && hub.id === "eng-testdup-m176-m177-m178");
  // The car comes with it, onto the VARIANT the folded node turned into --
  // which is the point of the fold: "M176 exists twice, once as an engine and
  // another time as an enginevar", and the enginevar is the right one.
  const carEdges = DATA.links.filter(l => l.type === "fitted" && !l.retired &&
    [l.source, l.target].map(v => (v && v.id) || v).indexOf(CAR) >= 0);
  // Looked up in DATA.nodes, not the live index: the variant the merge just
  // created has not been spliced into byId yet.
  const nodeById = id => DATA.nodes.find(n => n.id === id);
  const onVariant = carEdges.filter(l => {
    const other = [l.source, l.target].map(v => (v && v.id) || v).find(id => id !== CAR);
    const n = nodeById(other);
    return n && (n.id === hub.id || n.engineOf === hub.id);
  });
  check("...carrying the car it was connected to, onto this engine",
        onVariant.length === 1,
        carEdges.map(l => (l.source.id || l.source) + "->" + (l.target.id || l.target)).join(", "));
  check("...as a variant of it, not as a second engine beside it",
        onVariant.every(l => {
          const other = [l.source, l.target].map(v => (v && v.id) || v).find(id => id !== CAR);
          return (nodeById(other) || {}).type === "enginevar";
        }),
        onVariant.map(l => (l.source.id || l.source) + "->" + (l.target.id || l.target)).join(", "));
  check("...and the decision is recorded so it survives a reload",
        LF.allEngineMerges().some(m => (m.memberIds || []).indexOf("eng-testdup-m177") >= 0),
        JSON.stringify(LF.allEngineMerges()));
}
// The second shape: an unresearched node named after a variant that already
// exists. The real one is a stray "Duramax LB7" next to the Duramax.
{
  const dmax = { id: "eng-testdup-duramax", type: "engine", label: "Duramax",
                 wp: "TestDup Duramax V8 engine", variants: [] };
  DATA.nodes.push(dmax);
  const v = { id: "engv-testdup-duramax-lb7", type: "enginevar", label: "Duramax LB7",
              engineOf: dmax.id, wp: dmax.wp };
  DATA.nodes.push(v); dmax.variants.push(v.id);
  const stray = { id: "eng-testdup-duramax-lb7", type: "engine", label: "Duramax LB7",
                  wp: "TestDup Duramax LB7", unresearched: true, variants: [] };
  DATA.nodes.push(stray);
  cw.spliceIntoIndexes(0, 0);
  LF.autoMergeDuplicateEngines(DATA.nodes, DATA.links);
  check("an unresearched engine that is already someone's variant folds in",
        cw.byId.get("eng-testdup-duramax-lb7").retired, cw.byId.get("eng-testdup-duramax-lb7").retired);
  check("...and the engine it belongs to is the one kept", !dmax.retired);
}
// Two genuinely different engines are not touched.
{
  const a = { id: "eng-testdup-alpha", type: "engine", label: "Alpha", wp: "TestDup Alpha engine", variants: [] };
  const b = { id: "eng-testdup-beta", type: "engine", label: "Beta", wp: "TestDup Beta engine", variants: [] };
  DATA.nodes.push(a, b);
  cw.spliceIntoIndexes(0, 0);
  LF.autoMergeDuplicateEngines(DATA.nodes, DATA.links);
  check("two engines with two articles stay two engines", !a.retired && !b.retired);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
