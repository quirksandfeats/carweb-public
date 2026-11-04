// A generation still built after the next one began stays open. Its article says so in
// its card or heading. Everything else with no end still closes at the next start, and
// the succession pass still hands over at that start, so only the displayed end changes.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const check = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = fakeCtx;
window.requestAnimationFrame = () => 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "{}" });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
const shipped = JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") window.LLM_FAMILIES = Object.assign({}, shipped, { __serverAvailable: false });
  ev(f);
}
window.CarWeb.boot();
const nodes = window.CARDATA.nodes, links = window.CARDATA.links;
const LF = window.LlmFamilies;
const at = id => nodes.find(n => n.id === id);

// ---- the rule a new read goes through
const section = (title, card) => `== ${title} ==\n{{Infobox automobile\n| name = x\n${card}\n}}\nText.\n`;
const read = (gens, text) => { LF.endYearsFromOwnCards(gens, text); return gens; };
const gen = (code, yearStart, yearEnd) => ({ code, yearStart, yearEnd, designers: [], engineers: [], sharedPlatforms: [] });
{
  const text = section("First generation (AB1; 2015)", "| production = 2015–present") +
    section("Second generation (AB2; 2022)", "| production = 2022–present");
  const [a] = read([gen("AB1", 2015, null), gen("AB2", 2022, null)], text);
  check("a card and a read both open mark the generation", a.stillBuilt === true && a.yearEnd === null);
}
{
  const text = section("First generation (AB1; 2015)", "| production = 2015–present") +
    section("Second generation (AB2; 2022)", "| production = 2022–present");
  const [a] = read([gen("AB1", 2015, 2022), gen("AB2", 2022, null)], text);
  check("a read that states an end is not reopened", !a.stillBuilt && a.yearEnd === 2022);
}
{
  const text = section("First generation (AB1; 2019)", "| production = 2019–present\n| model_years = 2021–2026") +
    section("Second generation (AB2; 2025)", "| production = 2025–present");
  const [a] = read([gen("AB1", 2019, null), gen("AB2", 2025, null)], text);
  check("another range with an end leaves it unmarked (the Seltos)", !a.stillBuilt);
}
{
  const text = section("First generation (AB1; 2015)", "| production = 2015–2021") +
    section("Second generation (AB2; 2022)", "| production = 2022–present");
  const [a] = read([gen("AB1", 2015, null), gen("AB2", 2022, null)], text);
  check("a card with an end gives the end and no mark", !a.stillBuilt && a.yearEnd === 2021);
}
{
  const text = "== Fifth generation (2001–present) ==\nText about it.\n== Sixth generation (2015–present) ==\nMore.\n";
  const [a] = read([gen("Fifth generation", 2001, null), gen("Sixth generation", 2015, null)], text);
  check("a heading alone marks the generation (the Hino Ranger)", a.stillBuilt === true);
}
{
  const fam = { id: "fam-x" };
  const g = { id: "g-x", label: "AB1", year: 2015 };
  check("an unmarked generation is not open", !LF.generationStatedOpen(fam, g));
  window.LLM_FAMILIES.families["fam-x"] = { proposal: { generations: [{ code: "AB1", yearStart: 2015, yearEnd: null, stillBuilt: true }] } };
  check("a marked read keeps its generation open", LF.generationStatedOpen(fam, g) === true);
  window.LLM_FAMILIES.families["fam-x"].proposal.generations[0].yearEnd = 2020;
  check("a mark with an end does not hold it open", !LF.generationStatedOpen(fam, g));
  delete window.LLM_FAMILIES.families["fam-x"];
}

// ---- the shipped graph
const open = {
  "m-toyota-land-cruiser-j70": 1984, "llm-m-toyota-innova-an140": 2015,
  "llm-m-isuzu-d-max-second-generation-rt": 2011, "llm-m-dongfeng-rich-second-generation": 2014,
  "llm-m-toyota-hilux-an110-an120-an130": 2015, "m-ford-mustang-seventh-generation": 2022,
  "m-bmw-2-series-g42": 2021, "llm-m-fiat-panda-319": 2011,
};
for (const [id, year] of Object.entries(open)) {
  const n = at(id);
  check(`${id} runs from ${year}`, !!n && n.year === year && n.end == null, n && n.end);
}
const closed = {
  "llm-m-kia-seltos-sp2-first-generation": 2025, "llm-m-buick-gl8-third-generation-2016-2025": 2025,
  "llm-m-dongfeng-rich-rich-7": 2026, "m-mercedes-benz-c-class-w205": 2021,
  "llm-fam-chevrolet-silverado-gmt-t1xx": 2026,
};
for (const [id, end] of Object.entries(closed)) {
  const n = at(id);
  check(`${id} still ends ${end}`, !!n && n.end === end, n && n.end);
}
const idOf = v => (typeof v === "string" ? v : v && v.id);
const has = (a, b, type) => links.some(l => !l.retired && l.type === type && idOf(l.source) === a && idOf(l.target) === b);
check("the J70 still hands over to the Prado J90", has("m-toyota-land-cruiser-j70", "llm-m-toyota-land-cruiser-prado-j90", "succession"));
check("the Hilux AN110 does not pair with the Tacoma that began the same year",
  !has("llm-m-toyota-hilux-an110-an120-an130", "llm-m-toyota-tacoma-third-generation-n240-n260-n300-n310-n320-n330", "succession"));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
