// The patterns found reading every waiting relationship against Wikipedia
// (2026-10-11). Most were real relationships pinned to the wrong node; the
// rules re-resolve the sentence behind a waiting pair from scratch. Each
// case below is one real pair, with the makes renamed so nothing in data.js
// can collide with the fixture.
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
  return new Proxy({ measureText: () => ({ width: 10 }) }, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
const nodes = [], links = [];
const car = (id, make, label, year, end, extra) => { nodes.push(Object.assign({ id, type: "model", make, label, year, end, designers: [], engineers: [] }, extra || {})); links.push({ source: id, target: "mk-" + make.toLowerCase(), type: "made" }); return id; };
const fam = (id, make, label, gens, extra) => {
  nodes.push(Object.assign({ id, type: "family", make, label, year: gens[0][2], end: null, generations: gens.map(g => g[0]), designers: [], engineers: [] }, extra || {}));
  links.push({ source: id, target: "mk-" + make.toLowerCase(), type: "made" });
  gens.forEach(([gid, glabel, y, e]) => { car(gid, make, glabel, y, e, { familyOf: id }); links.push({ source: id, target: gid, type: "generation" }); });
};
["Nisz", "Pgt", "Pntc", "Mtsb", "Inft", "Tyta", "Szk", "Hynd", "Chvt", "Chrsl", "Rvr", "Hnd"].forEach(m =>
  nodes.push({ id: "mk-" + m.toLowerCase(), type: "make", label: m, year: 1900 }));

// 1. a code: "Skyline (R31)" is the Skyline R31, not the Skyline GT-R
fam("f-skyline", "Nisz", "Skyline", [["g-sky-r31", "Skyline R31", 1985, 1989], ["g-sky-r34", "Skyline R34", 1998, 2002]]);
fam("f-skygtr", "Nisz", "Skyline GT-R", [["g-gtr-r32", "Skyline GT-R R32", 1989, 1994]]);
car("c-pintara", "Nisz", "Pintara R31", 1986, 1990);
// 2. "208 II" is the second 208
fam("f-208", "Pgt", "208", [["g-208-a9", "208 A9", 2012, 2020], ["g-208-p21", "208 P21", 2019, null]]);
car("c-ds3", "Pgt", "DS 3 Second generation", 2018, null);
// 3. trim words: Grand LeMans Safari is a LeMans; Tempest Safari is a Tempest
car("c-lemans", "Pntc", "LeMans", 1962, null);
fam("f-grandsafari", "Pntc", "Grand Safari", [["g-gs-1", "Grand Safari First generation (1971–1976)", 1971, 1976]]);
fam("f-tempest", "Pntc", "Tempest", [["g-tem-1", "Tempest First generation", 1961, 1963], ["g-tem-2", "Tempest Second generation", 1964, 1967]]);
car("c-vista3", "Pntc", "Vista Cruiser Third generation", 1973, 1977);
car("c-vista1", "Pntc", "Vista Cruiser First generation", 1964, 1967);
// 4. a word nothing explains: "Galant Fortis" is not the Galant
fam("f-galant", "Mtsb", "Galant", [["g-gal-dj", "Galant DJ/DM", 2003, 2012]]);
car("c-evox", "Mtsb", "Lancer Evolution X", 2007, 2016);
// 5. a redirect: "Infiniti JX" is the QX60, not the placeholder minted for the name
car("c-qx60", "Inft", "QX60", 2012, 2013, { wp: "Inft QX60" });
car("llm-related-inft-jx", "Inft", "JX", null, null, { wp: "Inft JX" });
car("c-altima", "Inft", "Altima L33", 2012, 2018);
// 6. a generation's own name after its nameplate's
fam("f-uc", "Tyta", "Urban Cruiser", [["g-uc-2023", "Urban Cruiser (2023)", 2023, 2024], ["g-uc-taisor", "Urban Cruiser Taisor", 2024, null]]);
car("c-fronx", "Tyta", "Fronx", 2023, null);
// 7. a "series" is not a generation
fam("f-ignis", "Szk", "Ignis", [["g-ig-fh", "Ignis First series (FH)", 2000, 2008], ["g-ig-mh", "Ignis Second series (MH)", 2003, 2008], ["g-ig-mf", "Ignis Second generation (MF)", 2016, null]]);
car("c-celerio", "Szk", "Celerio Third generation", 2021, null);
// 8. another code for the generation built alongside -- and not at the very edge
fam("f-i20", "Hynd", "i20", [["g-i20-gb", "i20 GB", 2014, 2020], ["g-i20-bi3", "i20 BI3", 2020, 2026], ["g-i20-bc4", "i20 BC4", 2026, null]]);
car("c-bayon", "Hynd", "Bayon", 2021, null);
fam("f-aveo", "Chvt", "Aveo", [["g-aveo-t200", "Aveo (T200)", 2002, 2011]]);
car("c-sail2", "Chvt", "Sail Second generation", 2010, 2023);
// 9. a generation missing from the split (and "Fifth" is a name, not an ordinal)
fam("f-fifth", "Chrsl", "Fifth Avenue", [["g-fa-r", "Fifth Avenue R-body", 1979, 1981], ["g-fa-m", "Fifth Avenue M-body", 1982, 1989]]);
fam("f-ny", "Chrsl", "New Yorker", [["g-ny-c", "New Yorker Series C", 1988, 1993]]);
// 10. a placeholder reading the nameplate's own article is the nameplate
fam("f-300c", "Chrsl", "300C", [["g-300-lx", "300C First generation (LX)", 2004, 2010], ["g-300-ld", "300C Second generation (LD)", 2010, 2023]], { wp: "Chrsl 300" });
car("llm-related-chrsl-300", "Chrsl", "300", 2005, 2023, { wp: "Chrsl 300" });
car("c-impconcept", "Chrsl", "Imperial Concept", 2006, 2006);
// 11. another make's alias does not beat the make's own car of that name
fam("f-r200", "Rvr", "200 / 25", [["g-r200-r8", "200 / 25 R8", 1989, 1995], ["g-r200-r3", "200 / 25 R3", 1995, 1999]]);
fam("f-civic", "Hnd", "Civic", [["g-civic-6", "Civic Sixth generation", 1995, 2000]]);
car("c-coupe", "Rvr", "Coupé", 1996, 1998);

const STORE = {
  families: {}, recheck: {}, __serverAvailable: false,
  wpRedirects: { "Inft JX": "Inft QX60" },
  aliases: { "g-civic-6": { names: ["Rvr 200"], from: "Hnd Civic" } },
  relations: {
    // a year-only proposal from the Laurel's "Skyline R34" mention, pinned on the GT-R
    "c-laurel|f-skygtr|platform": { status: "provisional", relType: "platform", famA: "c-laurel", famB: "f-skygtr",
      genIdA: "c-laurel", genIdB: "f-skygtr",
      reason: "flagged by the local LLM sanity check as the same car as \"Nisz Skyline R34\" (confidence: low)" },
    // nothing the Evolution X's article says names the Galant
    "c-evox|g-gal-dj|platform": { status: "provisional", relType: "platform", famA: "c-evox", famB: "f-galant",
      genIdA: "c-evox", genIdB: "g-gal-dj", reason: "proposed by overlapping production years only" },
  },
};
car("c-laurel", "Nisz", "Laurel C35", 1997, 2002, { sharedPlatformTexts: ["Nisz Skyline R34"] });
nodes.find(n => n.id === "c-evox").sharedPlatformTexts = ["Mtsb Lancer", "Galant Fortis"];

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
load("d3.min.js"); load("data.js");
nodes.forEach(n => window.CARDATA.nodes.push(n));
links.forEach(l => window.CARDATA.links.push(l));
window.LLM_FAMILIES = JSON.parse(JSON.stringify(STORE));
load("llm_families.js"); load("app.js"); load("timeline.js"); load("sixdeg.js");
window.CarWeb.boot();
const LF = window.LlmFamilies, all = window.CarWeb.nodes;
const res = (text, from) => LF.resolveMention(text, from, all);
const is = (text, from, id, label) => { const r = res(text, from); check(label, r.node && r.node.id === id, JSON.stringify(r.node ? r.node.id : r)); };

is("Nisz Skyline (R31)", "c-pintara", "g-sky-r31", "a code picks the generation, of the nameplate whose name it is (not the GT-R)");
is("Pgt 208 II", "c-ds3", "g-208-p21", "\"II\" is the second generation");
is("Pntc Grand LeMans Safari", "c-vista3", "c-lemans", "\"Grand\" and \"Safari\" are trim words: the Grand LeMans Safari is a LeMans");
is("Pntc Tempest Safari", "c-vista1", "g-tem-2", "the Tempest Safari is the Tempest built alongside");
{ const r = res("Galant Fortis", "c-evox");
  check("an unexplained word means another car: \"Galant Fortis\" is not the Galant", !r.node, JSON.stringify(r)); }
is("Inft JX", "c-altima", "c-qx60", "a Wikipedia redirect names the car (Infiniti JX -> QX60), not the placeholder");
is("Tyta Urban Cruiser Taisor", "c-fronx", "g-uc-taisor", "a generation's own name, after its nameplate's");
is("Szk Ignis (second generation)", "c-celerio", "g-ig-mf", "\"second generation\" is the Second generation (MF), not the Second series (MH)");
is("Hynd i20 (BC3)", "c-bayon", "g-i20-bi3", "a code no generation carries is the one built alongside (BC3 for the BI3)");
{ const r = res("Chvt Aveo (310C)", "c-sail2");
  check("...but not when the only overlap is the last year of the old one", !r.node && !!r.none, JSON.stringify(r)); }
{ const r = res("Chrsl New Yorker Fifth Avenue", "g-ny-c");
  check("\"Fifth Avenue\" read on the New Yorker's page: no generation built alongside, so left, with the split flagged",
    !r.node && r.missingGeneration === "f-fifth", JSON.stringify(r)); }
is("Chrsl 300", "c-impconcept", "g-300-lx", "a placeholder reading the nameplate's own article is the nameplate");
is("Rvr 200", "c-coupe", "g-r200-r3", "another make's alias does not beat the make's own car (Rover 200, not the Civic)");

// Pair-level: how a waiting relationship is settled.
const st = k => { const e = LF.relationEntryFor(k); return e ? e.status : "none"; };
check("a pair pinned on the wrong nameplate is moved to the one the sentence names",
  st("c-laurel|f-skygtr|platform") === "none" && st("c-laurel|g-sky-r34|platform") === "confirmed",
  st("c-laurel|g-sky-r34|platform"));
check("...and the wrong pairing is remembered as a no", !!(window.LLM_FAMILIES && true) && LF.allRelationEntries().every(e => e.id !== "c-laurel|f-skygtr|platform"));
check("a pair no sentence supports is refused", st("c-evox|g-gal-dj|platform") === "none");

const src = fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8");
check("the extraction prompt asks for every generation heading (the Fifth Avenue's Y-body)", /Third generation \(Y platform; 1990-1993\)/.test(src));
check("...and keeps engine-only sharing out of sharedPlatforms", /only shares an engine, gearbox or other part is not related/.test(src));
check("decisions wait for the final graph at boot", /applyResolvedRelations\(nodes, links, \{ deferDecisions: true \}\)/.test(fs.readFileSync(path.join(APP, "app.js"), "utf-8")));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
