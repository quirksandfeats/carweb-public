// A nameplate whose article runs several bodies side by side: each body succeeds only
// itself, and a generation of one body ends nothing for another (the 2 Series F45/F46,
// which showed 2014-2016 because the M2 F87 began in 2016).
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
const live = l => !l.retired;
const idOf = v => (typeof v === "string" ? v : v.id);
const succ = new Set(links.filter(l => live(l) && l.type === "gensucc").map(l => idOf(l.source) + ">" + idOf(l.target)));
const span = id => { const n = nodes.find(x => x.id === id); return n && n.year + "-" + n.end; };

check("F45/F46 ends when its article says", span("llm-fam-bmw-2-series-f45-f46") === "2014-2021", span("llm-fam-bmw-2-series-f45-f46"));
check("U06 still built", span("llm-fam-bmw-2-series-u06") === "2021-null", span("llm-fam-bmw-2-series-u06"));
check("M2 G87 still built", span("llm-fam-bmw-2-series-g87") === "2023-null", span("llm-fam-bmw-2-series-g87"));
check("the stated ends stay", span("m-bmw-2-series-f22") === "2013-2021" && span("llm-fam-bmw-2-series-f87") === "2016-2021" && span("llm-fam-bmw-2-series-f44") === "2020-2024");

for (const [a, b] of [
  ["m-bmw-2-series-f22", "m-bmw-2-series-g42"],
  ["llm-fam-bmw-2-series-f87", "llm-fam-bmw-2-series-g87"],
  ["llm-fam-bmw-2-series-f45-f46", "llm-fam-bmw-2-series-u06"],
  ["llm-fam-bmw-2-series-f44", "llm-fam-bmw-2-series-f74-f78"],
  ["llm-m-ford-raptor-second-generation-2017", "llm-m-ford-raptor-third-generation-2021"],
  ["llm-m-ford-raptor-first-generation-2019", "llm-m-ford-raptor-second-generation-2022"],
]) check(a + " is followed by " + b, succ.has(a + ">" + b));
for (const [a, b] of [
  ["m-bmw-2-series-f22", "llm-fam-bmw-2-series-f45-f46"],
  ["llm-fam-bmw-2-series-f45-f46", "llm-fam-bmw-2-series-f87"],
  ["m-bmw-2-series-g42", "llm-fam-bmw-2-series-u06"],
  ["llm-m-ford-raptor-third-generation-2021", "llm-m-ford-raptor-first-generation-2019"],
]) check(a + " is not followed by " + b, !succ.has(a + ">" + b));

// A family with no lines keeps its one chain by year.
const fam = nodes.find(n => n.id === "fam-toyota-corolla");
const chain = fam.generations.map(id => nodes.find(n => n.id === id)).filter(g => g && !g.retired && !g.future && g.year != null);
check("a family without lines still chains", links.some(l => live(l) && l.type === "gensucc" && chain.some(g => g.id === idOf(l.source)) && chain.some(g => g.id === idOf(l.target))));

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
