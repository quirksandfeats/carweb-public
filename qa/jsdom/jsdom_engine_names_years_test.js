// Two reports from the same look at the Powertrain tab, both driven here by
// the real Mercedes-Benz M139 article.
//
// 1. Names. "Read through the names of the engines and engine variants...
//    it looks to be a formatting issue": the variants came out as "M139 (285
//    kW version) {{anchor|285 kW}}", and one engine's card was titled
//    "{{convert|305|CID|L|1|abbr=on}}". An anchor is metadata for linking and
//    a displacement is not a name.
//
// 2. Years. "In many cases the specific generations linked to them were
//    inaccurate. For example, in the graph it lists the CLA 178 as being
//    linked to the M139, despite it coming out in 2025 (not 2019), and being
//    associated with the model that existed in 2019, not later." Every M139
//    application states its year -- "*2019 - [[Mercedes-Benz CLA#C118|...]]"
//    -- which is a hard fact about which generation it can possibly mean.
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

const M139 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M139_engine.wikitext"), "utf-8");
const GMCV6 = fs.readFileSync(path.join(CACHE, "GMC_V6_engine.wikitext"), "utf-8");

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
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));

// A CLA with the two generations the M139 could mean, plus the node from the
// report: a 2025 car whose label carries no chassis code at all.
const FAM = "fam-mb-cla", C117 = "m-mb-cla-c117", C118 = "m-mb-cla-c118", ODD = "m-mb-cla-178";
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-mb4", type: "make", label: "Mercedes-Benz", year: 1926 };
    D.nodes.push(mk, { id: FAM, type: "family", label: "CLA", make: "Mercedes-Benz",
                       wp: "Mercedes-Benz CLA", generations: [C117, C118, ODD],
                       designers: [], engineers: [] });
    D.links.push({ source: FAM, target: mk.id, type: "made" });
    [[C117, "CLA (C117)", 2013, 2019], [C118, "CLA (C118)", 2019, null],
     [ODD, "CLA 178", 2025, null]].forEach(([id, label, y, e]) => {
      D.nodes.push({ id, type: "model", label, make: "Mercedes-Benz", familyOf: FAM,
                     year: y, end: e, designers: [], engineers: [] });
      D.links.push({ source: FAM, target: id, type: "generation" });
    });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
window.CarWeb.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- 1. the names ----------
const read = LF.readEngineArticle(M139, "Mercedes-Benz M139 engine");
{
  const codes = read.variants.map(v => v.code);
  check("the M139's four variants are found", codes.length === 4, codes.join(" | "));
  check("...without the anchor template in their names",
        !codes.some(c => /\{\{|anchor/i.test(c)), codes.join(" | "));
  check("...reading as the article's own headings do",
        codes[0] === "M139 (285 kW version)" && codes[3] === "M139I (350 kW version)",
        codes.join(" | "));

  // The other half: an engine a car's infobox names by its displacement.
  check("a mention whose display text is a measurement is not used as a name",
        LF.mentionName("{{convert|305|CID|L|1|abbr=on}}", "GMC V6 engine") === "GMC V6",
        LF.mentionName("{{convert|305|CID|L|1|abbr=on}}", "GMC V6 engine"));
  check("...nor is a bare displacement in plain text",
        LF.mentionName("5.0 L", "Mercedes-Benz M117 engine") === "M117",
        LF.mentionName("5.0 L", "Mercedes-Benz M117 engine"));
  check("a real name still wins over the title",
        LF.mentionName("M177", "Mercedes-Benz M176/M177/M178 engine") === "M177",
        LF.mentionName("M177", "Mercedes-Benz M176/M177/M178 engine"));
  check("...including one that carries a number, like N55B30M0",
        LF.mentionName("N55B30M0", "BMW N55") === "N55B30M0");
  check("the GMC V6 article is still readable as an engine", LF.isEngineArticle(GMCV6));
}

// ---------- 2. the years ----------
{
  const apps = [];
  read.variants.forEach(v => v.applications.forEach(a => apps.push(a)));
  const cla2019 = apps.filter(a => a.target === "Mercedes-Benz CLA" && a.yearStart === 2019);
  check("(precondition) the CLA applications state 2019 and the C118 anchor",
        cla2019.length >= 2 && cla2019.every(a => a.anchor === "C118"),
        cla2019.length + " · " + (cla2019[0] && cla2019[0].anchor));

  const planned = LF.planEngineEdgesWith(apps, DATA.nodes, new Map(), () => null);
  const onCla = planned.filter(p => p.node.familyOf === FAM || p.node.id === FAM);
  check("the CLA edges land on the C118, which the anchor names",
        onCla.length > 0 && onCla.every(p => p.node.id === C118),
        onCla.map(p => p.node.id).join(", "));
  check("...and never on the 2025 car, which was not being built in 2019",
        !planned.some(p => p.node.id === ODD),
        planned.filter(p => p.node.id === ODD).length);
  check("...nor on the C117, which had ended",
        !planned.some(p => p.node.id === C117),
        planned.filter(p => p.node.id === C117).length);

  // Year-only, no code: one generation was being built then and the others
  // were not, which is an answer on its own.
  const noCode = { target: "Mercedes-Benz CLA", anchor: null, display: "CLA 45",
                   text: "CLA 45", yearStart: 2021, yearEnd: null, note: null };
  const byYear = LF.planEngineEdgesWith([noCode], DATA.nodes, new Map(), () => null);
  check("an application with a year but no code still finds the right generation",
        byYear.length === 1 && byYear[0].node.id === C118,
        byYear.map(p => p.node.id).join(", "));

  // ...and a year nothing covers must not be forced onto a wrong generation.
  const ancient = { target: "Mercedes-Benz CLA", anchor: null, display: "CLA",
                    text: "CLA", yearStart: 1974, yearEnd: null, note: null };
  const old = LF.planEngineEdgesWith([ancient], DATA.nodes, new Map(), () => null);
  check("a year no generation covers falls back to the nameplate, not a guess",
        old.length === 1 && old[0].node.id === FAM, old.map(p => p.node.id).join(", "));

  // A car with no year on file is not contradicted by anything.
  check("a car with no years on file is left alone",
        LF.yearsCover({ type: "model", year: null, end: null }, 2019));
  check("...and an open-ended run covers everything after it",
        LF.yearsCover({ type: "model", year: 2019, end: null }, 2026));
  check("...while a closed one does not", !LF.yearsCover({ type: "model", year: 2013, end: 2019 }, 2024));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
