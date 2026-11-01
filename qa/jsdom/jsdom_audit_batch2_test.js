// Second audit round, relationship matching and engine reading. Each case comes
// from a finding checked against the real graph or a real Wikipedia article.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const gen = (code, y0, y1, sp, extra) => Object.assign({ code, yearStart: y0, yearEnd: y1, designers: [], engineers: [], sharedPlatforms: sp || [] }, extra);
const split = gens => ({ status: "confirmed", decidedAt: "2026-10-01T00:00:00Z", sourceTitle: "x", proposal: { hasMultipleGenerations: true, generations: gens } });
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = fakeCtx;
window.requestAnimationFrame = () => 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const D = window.CARDATA;
const model = (slug, label, y0, y1) => ({ id: "m-tev-" + slug, type: "model", label, make: "TestEv", year: y0, end: y1, wp: "TestEv " + label });
D.nodes.push({ id: "mk-tev", type: "make", label: "TestEv" },
  model("mark-ii", "Mark II", 1968, 2007), model("brevis", "Brevis", 2001, 2007),
  model("malibu", "Malibu", 1964, 1972), model("skylark", "Skylark", 1964, 1998),
  model("micra", "Micra", 2002, 2010), model("note", "Note", 2005, 2012), model("oasis", "Oasis", 1996, 1999), model("odyssey", "Odyssey", 1995, 2003), model("rodeo", "Rodeo", 1988, 2002));
const auto = "matched automatically -- the nameplate was named exactly in the source text; this generation's own section of its article names this car";
const relKeyOf = (a, b) => [a, b].sort().join("|") + "|platform";
const A = "llm-m-tev-malibu-first-generation", B = "llm-m-tev-skylark-seventh-generation", C = "llm-m-tev-malibu-second-generation";
window.LLM_FAMILIES = { families: {
  "m-tev-mark-ii": split([gen("X10", 1968, 1972), gen("X20", 1972, 1976)]),
  "m-tev-brevis": split([gen("First generation", 2001, 2004, ["TestEv Mark II"]), gen("Second generation", 2005, 2007)]),
  "m-tev-malibu": split([gen("First generation", 1964, 1967, ["TestEv Skylark"]), gen("Second generation", 1968, 1972, ["TestEv Skylark"])]),
  "m-tev-skylark": split([gen("Second generation", 1964, 1967), gen("Third generation", 1968, 1972, ["TestEv Malibu"]), gen("Seventh generation", 1992, 1998, ["TestEv Malibu"])]),
  "m-tev-micra": split([gen("K11", 2002, 2004), gen("K12", 2005, 2010, ["TestEv Note"])]),
  "m-tev-odyssey": split([gen("RA1", 1995, 1999, ["TestEv Oasis"], { sharedPlatformMatches: { "TestEv Oasis": { matchId: "m-tev-rodeo", confidence: "high" } } }), gen("RA6", 1999, 2003)]),
}, relations: {
  [relKeyOf(A, B)]: { status: "confirmed", famA: "m-tev-malibu", famB: "m-tev-skylark", relType: "platform", genIdA: A, genIdB: B, reason: auto, llmDiscovered: true },
  [relKeyOf(C, B)]: { status: "confirmed", decidedBy: "user", famA: "m-tev-malibu", famB: "m-tev-skylark", relType: "platform", genIdA: C, genIdB: B, reason: auto, llmDiscovered: true },
}, recheck: {}, engineMerges: {
  "eng-a": { memberIds: ["eng-b"], mergedAt: "2026-10-13T08:05:41Z" }, "eng-b": { memberIds: ["eng-a"], mergedAt: "2026-10-13T21:40:24Z" },
  "eng-c": { memberIds: ["eng-d"], mergedAt: "2026-10-13T21:40:24Z" } }, __serverAvailable: false };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
window.CarWeb.boot();
const store = window.LLM_FAMILIES, R = store.relations, LF = window.LlmFamilies;
const between = (a, b) => Object.values(R).filter(e => [e.genIdA, e.genIdB].some(x => x && x.includes(a)) && [e.genIdA, e.genIdB].some(x => x && x.includes(b)));

t("a nameplate called Mark II is not read as its second generation", between("brevis-first", "mark-ii-x20").length === 0, JSON.stringify(Object.keys(R).filter(k => k.includes("brevis"))));
t("a section decades away does not claim a car that names the nameplate", !Object.values(R).some(e => e.genIdA === A && e.genIdB === B));
t("...and that earlier automatic edge is gone", !R[relKeyOf(A, B)]);
t("the owner's own edge stays", !!R[relKeyOf(C, B)]);
t("a section built alongside a sibling generation belongs to the sibling", between("malibu-first", "skylark-third").length === 0);
t("the generation built alongside takes the edge", between("malibu-first", "skylark-second").length === 1);
t("a car named exactly outranks a stored guess", between("odyssey-ra1", "rodeo").length === 0 && between("odyssey-ra1", "oasis").length + (window.CARDATA.links.some(l => /odyssey/.test(String(l.source && l.source.id || l.source)) && /oasis/.test(String(l.target && l.target.id || l.target))) ? 1 : 0) >= 1);
t("two engines folded into each other come apart", !store.engineMerges["eng-a"] && !store.engineMerges["eng-b"]);
t("...and a one-way fold stays", !!store.engineMerges["eng-c"]);

store.families["m-tev-note"] = split([gen("E11", 2005, 2012), gen("E12", 2013, 2020)]);
LF.applyConfirmed(D.nodes, D.links);
t("a split in a live session reaches cars that already named the nameplate", between("micra-k12", "note-e11").length === 1, JSON.stringify(Object.keys(R).filter(k => k.includes("micra"))));

const fest = [{ id: "fam-f", type: "family", label: "Festiva", make: "TestEv", year: 1986, end: 2000, wp: "TestEv Festiva", generations: ["g1", "g2"] },
  { id: "g1", type: "model", label: "First", make: "TestEv", year: 1986, end: 2000, familyOf: "fam-f" }, { id: "g2", type: "model", label: "Second", make: "TestEv", year: 1993, end: 2000, familyOf: "fam-f" }];
const app = LF.parseApplicationLine("* 1988-2000 [[TestEv Festiva]]");
const placedIds = LF.planEngineEdgesWith([app], fest, new Map()).map(p => (p.node || p.car || p).id).sort().join();
t("a run into the next generation reaches both", placedIds === "g1,g2", placedIds);
const isd = [{ id: "mk-i", type: "make", label: "Isdera", wp: "Isdera" }];
let minted = 0;
LF.planEngineEdgesWith([LF.parseApplicationLine("* 1983-1991 [[Isdera|Isdera Autobahnkurier]]")], isd, new Map(), () => { minted++; return null; });
t("a company link whose text names a car can make the car", minted === 1, minted);

const page = body => "{{Infobox engine|name=TE|configuration=V8}}\n" + body;
const jz = LF.readEngineArticle(page("==1JZ-GE==\n* [[TestEv Chaser]]/[[TestEv Cresta|Cresta]] (1990-1995)\n==2JZ-GTE==\n* 1993-2002 [[TestEv Supra]]\n"), "TE JZ", "TE JZ engine");
t("codes that open with a digit are variants", jz.variants.map(v => v.code).join() === "TE JZ 1JZ-GE,TE JZ 2JZ-GTE", jz.variants.map(v => v.code).join());
const chained = jz.variants[0].applications.map(a => a.target).join();
t("a bullet with trailing years gives every car joined on it", chained === "TestEv Chaser,TestEv Cresta", chained);
const lb = LF.readEngineArticle(page("==LB7==\n==L5P==\n==LLY==\n==TDI==\n"), "TE", "TE engine");
t("all-letter codes count where their siblings show the pattern", lb.variants.map(v => v.code).join() === "TE LB7,TE L5P,TE LLY", lb.variants.map(v => v.code).join());
const eb = LF.readEngineArticle(page("==V6==\n* 2010-2015 [[TestEv Taurus]]\n"), "TE", "TE engine");
t("a heading that only states a layout is not a variant", eb.variants.length === 0 && eb.applications.length === 1, eb.variants.length + "/" + eb.applications.length);
const mod = LF.readEngineArticle(page("==GT90==\ntext\n==Road cars==\n* 1996-2004 [[TestEv Mustang]]\n"), "TE", "TE engine");
t("one variant heading does not lose the cars outside it", mod.variants.length === 1 && mod.applications.map(a => a.target).join() === "TestEv Mustang");
const mix = LF.readEngineArticle("{{Infobox engine|name=TE|configuration=I3, I4 and 60° V6}}\n==TE1==\n==TE2==\n", "TE", "TE engine");
t("a family of mixed layouts passes none to its variants", !mix.specs.layout && mix.variants.every(v => !v.specs || !v.specs.layout), JSON.stringify(mix.variants.map(v => v.specs)));
const see = LF.readEngineArticle(page("==See also==\n* [[TestEv Other car]]\n"), "TE", "TE engine");
t("a See also list is not a list of cars", see.applications.length === 0);

const said = f => LF.engineMentions("{{Infobox automobile|name=X|engine=" + f + "}}").map(e => e.said || e.text);
t("a list template spelled with a space is split", said("{{plain list|\n* [[TestEv MR20 engine|MR20DD]]\n* [[TestEv QR25 engine|QR25DE]]\n}}").length === 2);
t("unbulletedlist is split", said("{{unbulletedlist|[[TestEv MR20 engine|MR20DD]]|[[TestEv QR25 engine|QR25DE]]}}").length === 2);
const numbered = said("{{Collapsible list|1=2.0 L [[TestEv M102 engine|M102]]|2=3.0 L [[TestEv M103 engine|M103]]}}");
t("a numbered argument's prefix does not stay in the text", numbered.length === 2 && !numbered.some(x => /^\d\s*=/.test(x)), JSON.stringify(numbered));
const m = LF.engineMentions("{{Infobox automobile|name=X|engine=[[TestEv V8 engine|350 V8 16V]]<br>350 cu in Olds Diesel V8 16V}}");
t("a generic number does not inherit another line's link", m.filter(e => e.links && e.links.length).length <= 1 || m.length === 1, JSON.stringify(m.map(e => e.links && e.links.length)));
t("a fuel is not an engine code", LF.looksLikeCodeLink("E85", "E85") === false);
t("a layout is not an engine code", LF.looksLikeCodeLink("Straight 6", "I-6") === false);
t("a real code still is", LF.looksLikeCodeLink("RB25DET", "RB25DET") === true);
t("two articles with different brackets keep different keys",
  LF.engineArticleKey({ id: "x", wp: "Ford Essex V6 engine (UK)" }) !== LF.engineArticleKey({ id: "y", wp: "Ford Essex V6 engine (Canadian)" }));
t("...and the word engine alone still joins", LF.engineArticleKey({ id: "x", wp: "Ford Essex engine" }) === LF.engineArticleKey({ id: "y", wp: "Ford Essex" }));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
