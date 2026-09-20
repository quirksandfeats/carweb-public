// "The Chevy Suburban has a crazy amount of engines for each of the
// generations, so I should be expecting to see far more of the engines that
// are being referenced." -- and "There can be multiple engines associated to
// one model (or one generation of a nameplate)."
//
// Measured against the real article: its twelve per-generation infoboxes name
// 39 engines. The graph was drawing 23. Two losses, both in the same
// assumption -- that one article plus one display name is one engine.
//
//   mergeEngineHits keyed on article|name. "5.3 L ... EcoTec3" and
//   "6.2 L ... EcoTec3" are one article and one name, so the 2015 generation
//   kept one of its two; the 1960 generation names seven and kept four.
//
//   The "fitted" edge keyed on engine|car. The 1960 Suburban runs THREE
//   Turbo-Thrifts -- 230, 250 and 292 cu in, one article between them -- so
//   two of the three had nowhere to go.
//
// Both now carry the variant the car's own line named, which is also what
// bindCarsToVariants moves onto a real variant node once the engine article
// is read.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const CACHE = path.resolve(__dirname, "..", "wiki_cache");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
};
function fakeCtx() {
  const noop = () => {};
  return new Proxy({ measureText: () => ({ width: 10 }) },
                   { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
const SUB = fs.readFileSync(path.join(CACHE, "Chevrolet_Suburban.wikitext"), "utf-8");

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") window.LLM_FAMILIES = { families: {}, __serverAvailable: false };
  ev(f);
}
const LF = window.LlmFamilies;

// The article's own generation sections, the way the powertrain read slices them.
// The headings carry anchor spans ("==Fifth generation (1960)<span class=
// "anchor" id="5"></span>=="), so they are found by their opening text rather
// than matched whole.
const section = title => {
  const at = SUB.indexOf("==" + title);
  if (at < 0) return null;
  const rest = SUB.slice(at + 2);
  const next = /\n==[^=]/.exec(rest);
  return SUB.slice(at, at + 2 + (next ? next.index : rest.length));
};

// ---------- one article, one name, several engines ----------
{
  const s = section("Eleventh generation (2015)");
  const hits = LF.engineMentions(s);
  check("the 2015 generation's two EcoTec3s are two engines, not one",
        hits.length === 2, hits.map(h => h.name + "/" + h.variant).join(", "));
  const merged = LF.mergeEngineHits([], hits);
  check("...and merging a second reading in does not collapse them",
        merged.length === 2, merged.map(h => h.variant).join(", "));
}
{
  const hits = LF.engineMentions(section("Fifth generation (1960)"));
  check("the 1960 generation keeps all seven of the engines its infobox names",
        hits.length === 7, hits.length);
  check("...including all three Turbo-Thrifts",
        LF.mergeEngineHits([], hits).filter(h => /Turbo-Thrift/.test(h.name)).length === 3);
  const hits67 = LF.engineMentions(section("Sixth generation (1967)"));
  check("the 1967 generation keeps all nine", LF.mergeEngineHits([], hits67).length === 9, hits67.length);
}

// ---------- and the graph draws one edge per engine, not per article ----------
{
  const nodes = [{ id: "mk-sub", type: "make", label: "Chevrolet", year: 1911 },
                 { id: "m-sub-1960", type: "model", label: "Suburban Fifth generation",
                   make: "Chevrolet", year: 1960, end: 1966 }];
  const links = [];
  const hits = LF.mergeEngineHits([], LF.engineMentions(section("Fifth generation (1960)")));
  const car = nodes[1];
  const r = LF.recordEngineMentionsFrom(hits, car, nodes, links);
  const fitted = links.filter(l => l.type === "fitted" && !l.retired);
  check("every engine the 1960 infobox names gets its own connection",
        fitted.length === 7, fitted.length + " edge(s) for " + hits.length + " engine(s)");
  const tt = fitted.filter(l => /turbo-thrift/i.test(String(l.source)));
  check("...so the three Turbo-Thrifts are three connections, not one",
        tt.length === 3, tt.map(l => l.variantHint).join(", "));
  check("...each saying which one it is",
        tt.every(l => l.variantHint) && new Set(tt.map(l => l.variantHint)).size === 3,
        tt.map(l => l.variantHint).join(", "));
  check("...off a single engine node for the article",
        new Set(tt.map(l => String(l.source))).size === 1);

  // Idempotent: reading the same article again adds nothing.
  const before = links.length;
  LF.recordEngineMentionsFrom(hits, car, nodes, links);
  check("reading the same list twice adds no second copy",
        links.length === before, before + " -> " + links.length);
  check("the engine count is reported, not silently zero", r.fitted === 7, r.fitted);
}

// ---------- engines the list names with no article to follow ----------
// The 1973 generation's infobox names seven and links exactly one.
{
  const s73 = section("Seventh generation (1973)");
  const linked = LF.engineMentions(s73);
  check("the one engine with an article is still the only engine node",
        linked.length === 1 && /Detroit Diesel/.test(linked[0].name),
        linked.map(h => h.name).join(", "));

  const bare = LF.unlinkedEngineMentions(s73);
  check("the other six are kept as stated", bare.length === 6, bare.map(u => u.name).join(", "));
  // In the units the line used. The wikitext says {{convert|350|cuin|...}};
  // "350 cu in" is what it states, and the linked engines on the same page
  // are recorded the same way.
  check("...named by what the line said, not by an invented code",
        bare.some(u => u.name === "350 cu in V8 (petrol)") &&
        bare.some(u => u.name === "454 cu in V8 (petrol)"),
        bare.map(u => u.name).join(", "));
  check("...carrying the fuel heading they sat under",
        bare.every(u => u.specs.fuel === "petrol"),
        bare.map(u => u.specs.fuel).join(", "));
  check("...and the years the line gave, where it gave any",
        bare.some(u => u.specs.yearStart === 1976 && u.specs.yearEnd === 1988),
        JSON.stringify(bare.map(u => [u.specs.yearStart, u.specs.yearEnd])));
  check("...with no code invented for any of them",
        bare.every(u => !/[A-Z]{1,2}\d{2,}/.test(u.name)), bare.map(u => u.name).join(", "));
  check("the linked one is NOT repeated among them",
        !bare.some(u => /diesel/i.test(u.specs.fuel || "") && /379|6\.2/.test(u.name)),
        bare.map(u => u.name).join(", "));
}
// A line with no link of its own that names an engine linked elsewhere in the
// same field is that engine, not a bare spec -- the GLA's second M270.
{
  const gla = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_GLA.wikitext"), "utf-8");
  const bare = LF.unlinkedEngineMentions(gla);
  check("an engine linked elsewhere in the same list is not demoted to a bare spec",
        !bare.some(u => /m270|m274/i.test(u.said || "")), bare.map(u => u.said).join(" | "));
}
// ---------- and they never become nodes or edges ----------
{
  const nodes = [{ id: "mk-u", type: "make", label: "Chevrolet", year: 1911 },
                 { id: "m-u-1973", type: "model", label: "Suburban Seventh generation",
                   make: "Chevrolet", year: 1973, end: 1991 }];
  const links = [];
  const s73 = section("Seventh generation (1973)");
  LF.recordEngineMentionsFrom(LF.engineMentions(s73), nodes[1], nodes, links);
  check("only the engine with an article gets a node",
        nodes.filter(n => n.type === "engine").length === 1,
        nodes.filter(n => n.type === "engine").map(n => n.label).join(", "));
  check("...and only it gets a connection",
        links.filter(l => l.type === "fitted").length === 1);
}

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
