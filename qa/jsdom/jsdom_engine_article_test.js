// Reading an engine article, which is the "nameplate" of the powertrain side.
// Real user request: "the link to, for example, the engine M256 contains
// information about the variants of that motor - this should be like the
// 'nameplate' equivalent for the main page... M256 also contains information
// about the cars which contain these engines."
//
// Driven by the real Mercedes-Benz M256 and BMW N55 wikitext, cached in
// qa/wiki_cache/. They agree on the overall shape and disagree about
// everything else, and it is the disagreements that this pins down -- every
// assertion below corresponds to something one of those two articles actually
// does, not to a fixture written to be easy.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

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

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
ev("llm_families.js");
const LF = window.LlmFamilies;

const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");
const N55 = fs.readFileSync(path.join(CACHE, "BMW_N55.wikitext"), "utf-8");
const GOLF = fs.readFileSync(path.join(CACHE, "Volkswagen_Golf.wikitext"), "utf-8");

// ---------- 1. telling an engine article from a car one ----------
{
  check("an engine article is recognised by its own infobox", LF.isEngineArticle(M256) && LF.isEngineArticle(N55));
  check("a car article is not", !LF.isEngineArticle(GOLF));
}

// ---------- 2. the spec card ----------
{
  const e = LF.readEngineArticle(M256, "M256");
  check("the engine's name comes off the infobox", e.name === "Mercedes-Benz M256", e.name);
  check("...and its maker", e.manufacturer === "Mercedes-Benz", e.manufacturer);
  check("...and its production span", e.production === "2017–present", e.production);
  check("...and its layout", e.configuration === "Straight-six", e.configuration);
  check("...and its predecessor, as a link to follow later",
        e.predecessor === "Mercedes-Benz M276", e.predecessor);
  // An infobox is mostly {{convert}}; dropping those wholesale left the
  // displacement field reading "<br/>".
  check("a {{convert}} field keeps its number instead of collapsing to markup",
        /2498/.test(e.displacement) && /2999/.test(e.displacement), JSON.stringify(e.displacement));
  const n = LF.readEngineArticle(N55, "N55");
  check("an empty infobox field is empty, not invented", n.manufacturer === "", JSON.stringify(n.manufacturer));
  check("...while the rest still reads", n.production === "2009–2021" && /2979/.test(n.displacement),
        n.production + " / " + n.displacement);
}

// ---------- 3. variants: the generations of an engine ----------
{
  const e = LF.readEngineArticle(M256, "M256");
  check("the M256's three variants are found", e.variants.length === 3,
        e.variants.map(v => v.code).join(" | "));
  check("...named as the article names them",
        e.variants[0].code === "M256 E25 DEH LA GR", e.variants[0].code);

  const n = LF.readEngineArticle(N55, "N55");
  check("the N55's five are found", n.variants.length === 5, n.variants.map(v => v.code).join(" | "));
  // The N55 article is a minefield of headings that look like variants and
  // are not: a power-output section, a tuner's sub-tree, and an entirely
  // separate engine sharing the page.
  const codes = n.variants.map(v => v.code).join(" | ");
  check("a power-output heading is not mistaken for a variant", !/272 kW/.test(codes), codes);
  check("...nor a tuner section", !/Alpina/i.test(codes), codes);
  check("...nor the SECOND engine the same article documents", !/S55/.test(codes), codes);
}

// ---------- 4. the cars, which is the point ----------
{
  const e = LF.readEngineArticle(M256, "M256");
  const all = e.variants.reduce((a, v) => a.concat(v.applications), []);
  check("every car the M256 went into is found", all.length === 21, all.length);

  const byDisplay = d => all.find(a => a.display === d);
  const gr = e.variants.find(v => v.code === "M256 E30 DEH LA GR");

  // A section anchor is not part of the article title.
  const s400 = byDisplay("S 400 L/S 450 L");
  check("a link with a section anchor resolves to the article, not the anchor",
        s400 && s400.target === "Mercedes-Benz S-Class (W223)", s400 && s400.target);
  check("...and its 'China only' note is kept", s400 && /China only/.test(s400.note || ""), s400 && s400.note);

  // An image got glued to the front of this line, so it is not a bullet at all.
  const cls = byDisplay("C257 CLS 450 / CLS 450 4MATIC");
  check("an entry with an image glued to the front of it is still read",
        !!cls && cls.target === "Mercedes-Benz CLS-Class (C257)", cls && cls.target);
  check("...with its years intact", cls && cls.yearStart === 2018 && cls.yearEnd === 2023,
        cls && (cls.yearStart + "-" + cls.yearEnd));

  // The case the user asked about by name.
  const bergmeister = byDisplay("Austro Daimler Bergmeister PHEV");
  check("a car whose link points at the COMPANY is still captured",
        !!bergmeister && bergmeister.target === "Austro-Daimler", bergmeister && bergmeister.target);
  check("...and the car's own name survives in the display text, which is the "
        + "only place it exists", !!bergmeister && /Bergmeister/.test(bergmeister.display));

  check("a commented-out entry stays out",
        !all.some(a => /E63 S E-Performance/.test(a.display)),
        all.map(a => a.display).filter(d => /E63/.test(d)).join(","));

  check("'2024–present' reads as open-ended, not as a 2024 end year",
        byDisplay("CLE 53 AMG") && byDisplay("CLE 53 AMG").yearStart === 2024 &&
        byDisplay("CLE 53 AMG").yearEnd === null);
  check("...and a closed range keeps both ends",
        byDisplay("W222 S 500") && byDisplay("W222 S 500").yearEnd === 2020);

  check("the same car under two variants is not collapsed into one",
        gr.applications.filter(a => /W223/.test(a.display)).length === 2,
        gr.applications.filter(a => /W223/.test(a.display)).map(a => a.display).join(" / "));

  // The variants table sits above the sections and is full of links; none of
  // its rows are applications.
  check("the power/torque table is not read as a list of cars",
        !all.some(a => /kW|Nm|rpm/.test(a.display)), all.map(a => a.display).join(" | ").slice(0, 80));
}

// ---------- 5. BMW puts the trim outside the link ----------
{
  const n = LF.readEngineArticle(N55, "N55");
  const first = n.variants[0].applications[0];
  check("the link text alone is the chassis code", first.display === "F10/F11/F07", first.display);
  check("...so the whole line is kept too, which is where the model is",
        /535i/.test(first.text), first.text);
  check("...and the target is the generation article",
        first.target === "BMW 5 Series (F10)", first.target);
  // A bare chassis-code article, which is a redirect to the real one.
  const f25 = n.variants[0].applications.find(a => a.display === "F25");
  check("a bare chassis-code target is taken as-is, for the fetch to resolve",
        !!f25 && f25.target === "BMW F25", f25 && f25.target);
}

// ---------- 6. an engine with no variant sections ----------
{
  const stub = "{{Infobox automobile engine\n| name = Test T1\n| manufacturer = [[TestCo]]\n}}\n" +
    "The '''T1'''.\n== Applications ==\n* 1998-2004 [[TestCo Alpha]]\n* 2004-2010 [[TestCo Beta|Beta II]]\n";
  const e = LF.readEngineArticle(stub, "T1");
  check("an engine with no variants still reports its cars", e.variants.length === 0 && e.applications.length === 2,
        e.variants.length + " variants / " + e.applications.length + " apps");
  check("...with targets and years", e.applications[1].target === "TestCo Beta" &&
        e.applications[1].yearStart === 2004, JSON.stringify(e.applications[1]));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
