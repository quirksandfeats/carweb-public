// Reading a car's engine list, against the five real articles the reports
// named.
//
// 1.  The Jaguar XE: "each engine is listed in a list, with the primary names
//     of the engines linked... the Ford Ecoboost in that list is the link that
//     should be followed, not 'turbo' or 'I4'... along with taking the
//     information that the engine is a 2.0L and it is an Inline 4, to find the
//     associated engine variant in the ford ecoboost wikipedia link (which is
//     a huge family of engines)."
//     The Land Rover series: "the unnamed engine '2.0L diesel' is relevant
//     since the title of the link is .../Land_Rover_engines#2-litre_diesel."
// 4.  "make sure that the link to the engine for a particular car doesn't say
//     'list of ___ engines', but actually identifies correctly the engine(s)
//     associated with it... make sure not to get too lost in these types of
//     articles."
// 7.  "the LS2 engine has no information about what cars use the engine, but
//     in the wikipedia it is clearly stated."
// 9.  The Cadillac de Ville's fifth generation: "HT-4100 / Buick / L62 / OHV /
//     Oldsmobile ... The engines in this case are all inaccurate."
// 10. The GLA: "These should be all of the engines attached to this specific
//     generation (x156, the first generation)."
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
const XE = read("Jaguar_XE");
const LRS = read("Land_Rover_series");
const DEVILLE = read("Cadillac_de_Ville_series");
const GLA = read("Mercedes-Benz_GLA");
const OLDS = read("Oldsmobile_Diesel_engine");
const ISUZU = read("List_of_Isuzu_engines");
const PORSCHE = read("List_of_Porsche_engines");

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
const names = ms => ms.map(m => m.name).join(", ");

// ---------- 1. the Jaguar XE: one engine per line, with its own specs ----------
{
  const m = LF.engineMentions(XE);
  check("all five of the XE's engines are found, not the three that carry a code",
        m.length === 5, names(m));
  const eco = m.find(x => /EcoBoost/.test(x.name));
  check("the engine on the line is the link followed, not the turbo or the I4",
        eco && eco.title === "Ford EcoBoost engine", eco && eco.title);
  check("...and the rest of the line is kept, which is what says WHICH EcoBoost",
        eco && eco.specs.displacement === "2.0 L" && eco.specs.cylinders === 4 &&
        eco.specs.layout === "I" && eco.specs.induction === "turbocharged",
        JSON.stringify(eco && eco.specs));
  check("...including the years it was offered", eco && eco.specs.yearEnd === 2017, eco && eco.specs.yearEnd);
  check("...and the anchor, which is the family page's own answer",
        eco && /2\.0 L/.test(eco.variant || ""), eco && eco.variant);
  const ing = m.filter(x => x.name === "Ingenium");
  check("an engine family named in one word is an engine", ing.length === 2, names(m));
  check("...and the petrol and the diesel are two, not one",
        ing.map(x => x.specs.fuel).sort().join("/") === "diesel/petrol",
        JSON.stringify(ing.map(x => x.specs.fuel)));
  check("nothing that is a turbo, a layout or a fuel came along",
        !m.some(x => /^(?:Turbocharger|Supercharger|Straight-\w+ engine|V\d+ engine|Petrol engine|Diesel engine|Inline-\w+ engine)$/.test(x.title)),
        m.map(x => x.title).join(" | "));
}

// ---------- 1b. the Land Rover series: the only link worth following ----------
{
  const m = LF.engineMentions(LRS);
  const lr = m.filter(x => x.title === "Land Rover engines");
  check("an engine with no name of its own is found through its section link",
        lr.length >= 2, names(m));
  check("...named by the section, not by the index it lives in",
        lr.some(x => /2-litre diesel/.test(x.name)), names(m));
  check("...even though the link is written with underscores",
        lr.every(x => !/_/.test(x.title)), JSON.stringify(lr.map(x => x.title)));
  check("\"L\" and \"I4\" are not engines",
        !m.some(x => /^(Liter|Litre|Inline-four|Straight-six)/.test(x.title)), m.map(x => x.title).join(" | "));
}

// ---------- 9. the de Ville: one generation's engines, not all eight eras' ----------
{
  const fam = { type: "family", label: "de Ville series", make: "Cadillac", wp: "Cadillac de Ville series" };
  const sec = LF.nameplateSectionForCar(
    { label: "de Ville series Fifth generation (1977–1984)", type: "model", familyOf: "f" }, fam, DEVILLE);
  check("the right generation's section is found", sec && sec.title === "Fifth generation (1977–1984)",
        sec && sec.title);
  const m = LF.engineMentions(sec.body);
  check("its five engines are the five that section names", m.length === 5, names(m));
  check("...named as engines rather than as their makers",
        !m.some(x => /^(Buick|Oldsmobile|Cadillac)$/.test(x.name)), names(m));
  check("...and not as the valvetrain", !m.some(x => /^OHV$/i.test(x.name)), names(m));
  check("...including the diesel this whole report started from",
        m.some(x => x.name === "LF9" && x.title === "Oldsmobile Diesel engine"), names(m));
  // The whole article read at once is every era at once, which is what the
  // section scoping exists to avoid.
  check("(for contrast) the whole article names far more than any one generation",
        LF.engineMentions(DEVILLE).length > 12, LF.engineMentions(DEVILLE).length);
  const third = LF.engineMentions(LF.nameplateSectionForCar(
    { label: "de Ville series Third generation (1965–1970)", type: "model", familyOf: "f" }, fam, DEVILLE).body);
  check("a link whose text is the valvetrain is named after its article",
        third.every(x => x.name === "Cadillac V8"), names(third));
  check("...and two engines of the same family are two, told apart by size",
        third.length === 2 && third[0].specs.displacement !== third[1].specs.displacement,
        JSON.stringify(third.map(x => x.specs.displacement)));
}

// ---------- 10. the GLA: every engine of the first generation ----------
{
  const fam = { type: "family", label: "GLA", make: "Mercedes-Benz", wp: "Mercedes-Benz GLA" };
  const sec = LF.nameplateSectionForCar(
    { label: "GLA X156", type: "model", familyOf: "f", year: 2013, end: 2019 }, fam, GLA);
  check("the X156's own section is found", !!sec, sec && sec.title);
  const m = LF.engineMentions(sec.body);
  check("all five of its engines are found", m.length === 5, names(m));
  check("...including the one written without a link, because the line above linked it",
        m.filter(x => x.name === "M270").length === 2 &&
        m.filter(x => x.name === "M270").map(x => x.specs.displacement).sort().join("/") === "1.6 L/2.0 L",
        JSON.stringify(m.filter(x => x.name === "M270").map(x => x.specs.displacement)));
  check("...with the petrols and the diesels told apart by their own heading",
        m.filter(x => x.specs.fuel === "diesel").length === 2 &&
        m.filter(x => x.specs.fuel === "petrol").length === 3,
        JSON.stringify(m.map(x => [x.name, x.specs.fuel])));
}

// ---------- 7. the Oldsmobile Diesel: applications stated as one year ----------
{
  const a = LF.readEngineArticle(OLDS, "Oldsmobile Diesel", "Oldsmobile Diesel engine");
  const ls2 = a.variants.find(v => /LS2$/.test(v.code));
  check("the LS2's cars are found, though its list states one year each",
        ls2 && ls2.applications.length === 4, ls2 && ls2.applications.length);
  check("...with that year as both its start and its end",
        ls2.applications.every(x => x.yearStart === 1985 && x.yearEnd === 1985),
        JSON.stringify(ls2.applications.map(x => [x.display, x.yearStart, x.yearEnd])));
  const lf7 = a.variants.find(v => /LF7$/.test(v.code));
  check("...and so are the LF7's", lf7 && lf7.applications.length === 2, lf7 && lf7.applications.length);
  const lf9 = a.variants.find(v => /LF9$/.test(v.code));
  check("the LF9 still names the Riviera it was reported against",
        lf9.applications.some(x => /Riviera/.test(x.display) && x.yearStart === 1981),
        JSON.stringify((lf9.applications.find(x => /Riviera/.test(x.display)) || {})));
  check("a displacement in cc is not read as a year",
        !a.variants.some(v => (v.applications || []).some(x => x.yearStart > 2030 || x.yearStart < 1880)),
        JSON.stringify(a.variants.map(v => (v.applications || []).map(x => x.yearStart))));
}

// ---------- 4. an index of a maker's engines ----------
{
  check("a 'List of X engines' article is recognised as an index",
        LF.isEngineListTitle("List of Isuzu engines") && !LF.isEngineListTitle("Mercedes-Benz M256 engine"));
  check("...and is readable, rather than 'not an engine article'",
        LF.isEngineArticle(ISUZU, "List of Isuzu engines"));
  const a = LF.readEngineArticle(ISUZU, "List of Isuzu engines", "List of Isuzu engines");
  check("read whole, it gives the maker's engine families",
        a.variants.length >= 15 && a.variants.some(v => v.code === "Isuzu J"),
        a.variants.map(v => v.code).join(", "));
  check("...named with their maker, not as bare letters",
        a.variants.every(v => /^Isuzu /.test(v.code)), a.variants.map(v => v.code).join(", "));
  check("...and it claims no cars of its own: an index links the valvetrain " +
        "and the country as readily as a car",
        a.applications.length === 0 && a.variants.every(v => !v.applications.length));
  // One engine out of it, which is what a car's link points at.
  const one = LF.readEngineArticle(ISUZU, "GH10", "List of Isuzu engines#GH10");
  check("read for one of them, it is that engine and not the index",
        one.shortName === "GH10" && one.applications.length === 0, one.shortName);
  // An index filed by CAR names no engines at all, which is the honest answer.
  const p = LF.readEngineArticle(PORSCHE, "List of Porsche engines", "List of Porsche engines");
  // Its headings are cars -- "Cayenne", "911", "Carrera GT" -- and none of
  // them comes back as an engine. What is left is the handful whose heading
  // really does say "engines" (the Junior and Standard tractor groups), which
  // is a heading this cannot tell from an engine family's name without
  // knowing the cars; it is a far smaller wrong than a graph full of cars
  // filed as engines.
  check("an index filed by car does not turn its cars into engines",
        !p.variants.some(v => /911|Boxster|Cayman|Cayenne|Carrera|356|Panamera|Macan|Taycan/.test(v.code)),
        p.variants.map(v => v.code).join(", "));
  check("...and what it does return is a short tail, not its whole contents",
        p.variants.length <= 6, p.variants.length + ": " + p.variants.map(v => v.code).join(", "));
  // ...and the mention side: a car's link to an index is only followed when
  // it says which engine.
  const withAnchor = LF.engineMentions("| engine = 2.0 L [[List of Isuzu engines#4ZE1|4ZE1]] I4");
  check("a car linking an index WITH an anchor gets the engine the anchor names",
        withAnchor.length === 1 && withAnchor[0].name === "4ZE1", JSON.stringify(withAnchor));
  const noAnchor = LF.engineMentions("| engine = 2.0 L [[List of Isuzu engines|Isuzu]] I4");
  check("...and one without an anchor gets nothing, rather than an engine " +
        "called 'List of Isuzu engines'",
        noAnchor.length === 0, JSON.stringify(noAnchor));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
