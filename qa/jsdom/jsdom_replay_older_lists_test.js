// A nameplate's earlier list is replayed once per load. The load replays lists
// several times, and each replay of the earlier one retired what the later list had
// added: the Type 2 lost its T2 at every reload. And a generation guess whose years
// leave one answer needs nobody: the Integra and the Civic's third generation.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const ARTICLES = { "TestRp Civ3": "{{Infobox automobile|name=TestRp Civ3|related=[[TestRp Intg]]}}\nA car.\n", "TestRp Far": "{{Infobox automobile|name=TestRp Far}}\nA car.\n" };
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window: w } = dom;
w.HTMLCanvasElement.prototype.getContext = fakeCtx;
w.requestAnimationFrame = () => 1;
w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
w.fetch = async url => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m && String(url).includes("prop=wikitext")) { const title = decodeURIComponent(m[1]); return { ok: true, json: async () => ARTICLES[title] ? { parse: { title, wikitext: { "*": ARTICLES[title] } } } : { error: {} } }; }
  return { ok: true, json: async () => ({}) };
};
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const gen = (code, yearStart, yearEnd) => ({ code, yearStart, yearEnd, designers: [], engineers: [], sharedPlatforms: [] });
const car = (id, label, year, end, more) => Object.assign({ id, type: "model", label, make: "TestRp", year, end, wp: "TestRp " + label }, more);
const list = (gens, more) => Object.assign({ status: "applied", sourceTitle: "TestRp Bus", proposal: { hasMultipleGenerations: true, generations: gens } }, more);
w.CARDATA.nodes.push({ id: "mk-testrp", type: "make", label: "TestRp" },
  { id: "f-bus", type: "family", label: "Bus", make: "TestRp", wp: "TestRp Bus", generations: ["g-t1", "g-t3"] },
  car("g-t1", "Bus T1", 1950, 1967, { familyOf: "f-bus" }), car("g-t3", "Bus T3", 1979, 1992, { familyOf: "f-bus" }),
  { id: "f-intg", type: "family", label: "Intg", make: "TestRp", wp: "TestRp Intg", generations: ["g-i1", "g-i2"] },
  car("g-i1", "Intg One", 1985, 1989, { familyOf: "f-intg" }), car("g-i2", "Intg Two", 1993, 2001, { familyOf: "f-intg" }),
  car("m-civ3", "Civ3", 1983, 1987), car("m-far", "Far", 1985, 1989));
w.CARDATA.links.push({ source: "f-bus", target: "g-t1", type: "generation" }, { source: "f-bus", target: "g-t3", type: "generation" },
  { source: "f-intg", target: "g-i1", type: "generation" }, { source: "f-intg", target: "g-i2", type: "generation" });
const guess = (a, gA, b) => ({ status: "provisional", matchLevel: "generation", relType: "related", famA: a, famB: b, genIdA: gA, genIdB: b, reason: "the model said so" });
w.LLM_FAMILIES = { families: {}, rejectedRelations: {},
  recheck: { "f-bus": list([gen("T1", 1950, 1967), gen("T2", 1967, 1979), gen("T3", 1979, 1992)],
    { olderOnce: true, appliedBefore: list([gen("T1", 1950, 1967), gen("T3", 1979, 1992)]) }) },
  relations: { "m-civ3|f-intg|related": guess("f-intg", "g-i1", "m-civ3"), "m-far|f-intg|related": guess("f-intg", "g-i1", "m-far"), "m-civ3|g-i2|related": guess("f-intg", "g-i2", "m-civ3") },
  __serverAvailable: true };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies, S = w.LLM_FAMILIES, nodes = w.CarWeb.nodes;
const by = id => nodes.find(n => n.id === id);
const t2 = nodes.find(n => n.familyOf === "f-bus" && /T2/.test(n.label));
t("the later list's generation is there", !!t2);
t("...and not retired by the earlier list's replay", t2 && !t2.retired, t2 && t2.supersededBy);
t("the generations in both lists stay", !by("g-t1").retired && !by("g-t3").retired);
LF.applyAllFamilyOverrides(nodes, w.CarWeb.links);
t("...through another replay", t2 && !t2.retired);
(async () => {
  await LF.sweepWeakRelations(nodes);
  t("a guess confirmed: the article names the car, and the years leave one generation", S.relations["m-civ3|f-intg|related"].status === "confirmed" && S.relations["m-civ3|f-intg|related"].decidedBy === "rules", S.relations["m-civ3|f-intg|related"].status);
  t("...not when neither article names it", S.relations["m-far|f-intg|related"].status === "provisional", S.relations["m-far|f-intg|related"].status);
  console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})();
