// Real user request: "I want that the engine details for the enginevar to
// contain some basic info about the engine, but only when I scan the engine
// itself for it to look at the wikipedia link. The process should be as
// follows: Scan a particular engine (not engine var), and then the llm
// determines whether this is a standalone engine or a family of engines. If it
// is standalone, then proceed to lay out the specs on it. If this engine
// contains enginevars, then split up into enginevars and then do the
// individual specs for each of the enginevars. The specs include displacement,
// power output, number of cylinders, and formation (like V pattern, inline,
// etc...). These should appear in the information card about the engine or
// engine var, depending on the logic explained above. If there is no
// information about this for a particular engine then do not try to make up
// information; only if there is actual information in the articles should you
// include this information."
//
// Standalone or a family is settled by the article, not asked of the model: an
// article with variant sections is a family. Read against the real M139, M256,
// M176/M177/M178, N55 and GMC V6 articles, which between them cover every
// shape the infoboxes use.
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
const read = f => fs.readFileSync(path.join(CACHE, f + ".wikitext"), "utf-8");
const M139 = read("Mercedes-Benz_M139_engine");
const M256 = read("Mercedes-Benz_M256_engine");
const M17X = read("Mercedes-Benz_M176_M177_M178_engine");
const N55 = read("BMW_N55");
const GMCV6 = read("GMC_V6_engine");

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
const ARTICLES = { "Mercedes-Benz M139 engine": M139 };
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
    D.nodes.push({ id: "mk-testspec", type: "make", label: "TestSpec", year: 1900 });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- 1. standalone or a family ----------
{
  const a = LF.readEngineArticle(M139, "M139", "Mercedes-Benz M139 engine");
  check("an article with variant sections is a family, not a standalone",
        a.standalone === false && a.variants.length >= 4, a.variants.length);
  // The M176/M177/M178 read for ONE of its engines is that engine on its own.
  const one = LF.readEngineArticle(M17X, "M177", "Mercedes-Benz M176/M177/M178 engine");
  check("...and one engine out of a shared page is read as itself",
        one.shortName === "M177", one.shortName);
}

// ---------- 2. the specs, as the article states them ----------
{
  const a = LF.readEngineArticle(M139, "M139", "Mercedes-Benz M139 engine");
  check("the cylinder count and the formation come out of the configuration field",
        a.specs.layout === "I" && a.specs.cylinders === 4,
        JSON.stringify([a.specs.layout, a.specs.cylinders]));
  check("...the displacement as written", a.specs.displacement === "1991 cc", a.specs.displacement);
  check("...and a power field listing two states of tune reads as the span",
        a.specs.power === "285-310 kW", a.specs.power);
  check("the card line is the four the user asked for, in order",
        LF.engineSpecSummary(a.specs) === "I4 · 1991 cc · 285-310 kW",
        LF.engineSpecSummary(a.specs));

  const v = LF.readEngineArticle(M256, "M256", "Mercedes-Benz M256 engine").specs;
  check("a V-angle in the configuration still gives the layout",
        v.layout === "I" && v.cylinders === 6, JSON.stringify([v.layout, v.cylinders]));
  check("...and two displacements read as a span", v.displacement === "2498-2999 cc", v.displacement);

  const eight = LF.readEngineArticle(M17X, "M176/M177/M178", "Mercedes-Benz M176/M177/M178 engine").specs;
  check("a 90° V8 is a V8", eight.layout === "V" && eight.cylinders === 8,
        JSON.stringify([eight.layout, eight.cylinders]));
  check("...and a {{convert}} range is a range, not a number and a dash",
        /^340-\d/.test(eight.power), eight.power);
}

// ---------- 3. per variant, and only what it says ----------
{
  const a = LF.readEngineArticle(M139, "M139", "Mercedes-Benz M139 engine");
  const byCode = {};
  a.variants.forEach(v => { byCode[v.code] = v.specs || {}; });
  check("each variant carries its own power, from its own heading",
        byCode["M139 (285 kW version)"].power === "285 kW" &&
        byCode["M139 (310 kW version)"].power === "310 kW",
        JSON.stringify(a.variants.map(v => [v.code, v.specs && v.specs.power])));
  check("...and inherits the layout, which every variant of one engine shares",
        a.variants.every(v => v.specs && v.specs.layout === "I" && v.specs.cylinders === 4),
        JSON.stringify(a.variants.map(v => v.specs)));
  check("...but never the family's displacement or power, which are what differ",
        a.variants.every(v => !v.specs.displacement) &&
        a.variants.every(v => v.specs.power !== a.specs.power),
        JSON.stringify(a.variants.map(v => v.specs)));
  // Nothing invented: a variant whose heading states no figures says nothing.
  const n = LF.readEngineArticle(N55, "N55", "BMW N55");
  check("a variant whose article says nothing about it claims nothing",
        n.variants.every(v => !v.specs || (!v.specs.power && !v.specs.displacement)),
        JSON.stringify(n.variants.map(v => [v.code, v.specs])));
  check("...and the summary of nothing is nothing", LF.engineSpecSummary(null) === "");
  // An article with no displacement field does not grow one.
  const g = LF.readEngineArticle(GMCV6, "GMC V6", "GMC V6 engine");
  check("a family with no displacement of its own does not invent one",
        !g.specs.displacement, g.specs.displacement);
  check("...while still reporting what it does state", g.specs.layout === "V" && !!g.specs.power,
        LF.engineSpecSummary(g.specs));
}

// ---------- 4. on the card ----------
(async () => {
  const before = DATA.nodes.length, lbefore = DATA.links.length;
  const r = await LF.checkEngine("Mercedes-Benz M139 engine", DATA.nodes, DATA.links,
                                 { cascade: false, mintCars: false });
  cw.spliceIntoIndexes(before, lbefore);
  check("(precondition) the engine was read", r.status === "confirmed", r.status);
  const eng = DATA.nodes.find(n => n.type === "engine" && /M139/.test(n.label));
  cw.openDetail(eng);
  const meta = window.document.querySelector(".dt-meta").textContent;
  check("the engine's card carries its specs",
        /I4/.test(meta) && /1991 cc/.test(meta) && /285-310 kW/.test(meta), meta);
  const v = DATA.nodes.find(n => n.type === "enginevar" && /285 kW/.test(n.label));
  check("(precondition) its variants are nodes", !!v, v && v.label);
  cw.openDetail(v);
  const vmeta = window.document.querySelector(".dt-meta").textContent;
  check("...and a variant's card carries its own",
        /I4/.test(vmeta) && /285 kW/.test(vmeta), vmeta);
  check("...without borrowing the family's displacement", !/1991 cc/.test(vmeta), vmeta);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
