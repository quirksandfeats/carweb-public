// The Jaguar XJ: a build nameplate on the "Jaguar XJ" article, and a "Jaguar XJ6"
// nameplate on the same article that another car's replay brought in too late for
// the fold, so every generation stood twice. A re-check could not fix it either:
// it only ever looks at one nameplate's own list.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window: w } = dom;
w.HTMLCanvasElement.prototype.getContext = fakeCtx;
w.requestAnimationFrame = () => 1;
w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
w.fetch = async () => ({ ok: true, json: async () => ({}) });
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const ART = "TestLt XJ";
const car = (id, label, year, end, wp, more) => Object.assign({ id, type: "model", label, make: "TestLt", year, end, wp }, more);
w.CARDATA.nodes.push({ id: "mk-testlt", type: "make", label: "TestLt" },
  { id: "fam-testlt-xj", type: "family", label: "XJ", make: "TestLt", year: 1968, end: 2019, wp: ART, generations: ["m-testlt-xj", "m-testlt-xj-x350"] },
  car("m-testlt-xj", "XJ", 1968, 1992, ART, { familyOf: "fam-testlt-xj" }),
  car("m-testlt-xj-x350", "XJ (X350)", 2002, 2009, "TestLt XJ (X350)", { familyOf: "fam-testlt-xj" }),
  car("m-testlt-mark-x", "Mark X", 1961, 1970, "TestLt Mark X"));
w.CARDATA.links.push({ source: "fam-testlt-xj", target: "m-testlt-xj", type: "generation" }, { source: "fam-testlt-xj", target: "m-testlt-xj-x350", type: "generation" },
  { source: "m-testlt-mark-x", target: "m-testlt-xj", type: "succession" }, { source: "m-testlt-mark-x", target: "fam-testlt-xj", type: "succession" });
w.LLM_FAMILIES = { families: {}, relations: {}, rejectedRelations: {}, renames: {},
  recheck: { "fam-testlt-xj": { status: "error", error: "no wikitext", manualRecheck: true } }, __serverAvailable: false };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies, S = w.LLM_FAMILIES, nodes = w.CarWeb.nodes, links = w.CarWeb.links;
const by = id => nodes.find(n => n.id === id), idOf = v => typeof v === "string" ? v : v.id;
const has = (type, a, b) => links.some(l => !l.retired && l.type === type && idOf(l.source) === a && idOf(l.target) === b);
t("before the fold the build nameplate is live", !by("fam-testlt-xj").retired);
const gen = (id, label, y0, y1) => car(id, label, y0, y1, ART, { familyOf: "llm-related-testlt-xj6", llmGenerated: true });
nodes.push({ id: "llm-related-testlt-xj6", type: "family", label: "XJ6", make: "TestLt", year: 1968, end: 2019, wp: ART, llmGenerated: true, generations: ["g-series-i", "g-x350"] },
  gen("g-series-i", "XJ6 Series I", 1968, 1973), gen("g-x350", "XJ6 (X350)", 2002, 2009));
t("the fold takes the late nameplate", LF.foldBuildFamiliesIntoLlmFamilies(nodes, links) > 0);
const kept = by("llm-related-testlt-xj6");
t("one nameplate is left", by("fam-testlt-xj").retired && by("fam-testlt-xj").supersededBy === kept.id);
t("the bare model goes into the nameplate", by("m-testlt-xj").retired && by("m-testlt-xj").supersededBy === kept.id);
t("a generation on both goes into its twin", by("m-testlt-xj-x350").retired && by("m-testlt-xj-x350").supersededBy === "g-x350");
t("the nameplate takes the article's name", kept.label === "XJ", kept.label);
t("...and its generations with it", by("g-series-i").label === "XJ Series I" && by("g-x350").label === "XJ (X350)", by("g-series-i").label);
t("the twin takes the generation's own article", by("g-x350").wp === "TestLt XJ (X350)", by("g-x350").wp);
t("a generation with no twin stays on the nameplate's article", by("g-series-i").wp === ART);
t("the bare model's connections move to the nameplate", has("succession", "m-testlt-mark-x", kept.id));
LF.settleDecidedRechecks(nodes);
t("the failed read of the folded nameplate no longer waits for a re-scan", !S.recheck["fam-testlt-xj"]);
t("a nameplate brought in late gets the fold", /applyResolvedRelations\(nodes, links, \{ deferDecisions: true \}\);[\s\S]{0,300}break;\s*\}[\s\S]{0,260}foldBuildFamiliesIntoLlmFamilies/.test(fs.readFileSync(path.join(APP, "app.js"), "utf-8")));
// A rename by hand stays.
S.renames["llm-related-testlt-b"] = { label: "Mine" };
nodes.push({ id: "fam-testlt-b", type: "family", label: "B", make: "TestLt", wp: "TestLt B", generations: ["m-testlt-b"] }, car("m-testlt-b", "B", 1990, 2000, "TestLt B", { familyOf: "fam-testlt-b" }),
  { id: "llm-related-testlt-b", type: "family", label: "Mine", make: "TestLt", wp: "TestLt B", llmGenerated: true, generations: ["g-b1"] }, car("g-b1", "Mine One", 1990, 2000, "TestLt B", { familyOf: "llm-related-testlt-b" }));
LF.foldBuildFamiliesIntoLlmFamilies(nodes, links);
t("a name chosen by hand is kept", by("llm-related-testlt-b").label === "Mine" && by("fam-testlt-b").retired, by("llm-related-testlt-b").label);
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
