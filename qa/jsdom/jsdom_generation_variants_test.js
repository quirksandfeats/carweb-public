// Facelifts, phases and body or powertrain versions fold into their generation (9 Nov 2026).
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
const DATA = window.CARDATA;
function idOf(v) { return typeof v === "string" ? v : v && v.id; }
const LF = window.LlmFamilies, byId = new Map(DATA.nodes.map(n => [n.id, n]));
const plate = (make, label) => DATA.nodes.find(n => !n.retired && n.type === "family" && n.make === make && n.label === label);
const gens = p => (p.generations || []).map(id => byId.get(id)).filter(g => g && !g.retired);
check("the list is loaded", Object.keys(window.GENERATION_VARIANTS || {}).length >= 30);
const diablo = plate("Lamborghini", "Diablo"), dg = diablo && gens(diablo);
check("the Diablo's facelift is a phase of its one generation", dg && dg.length === 1 && LF.phasesOf(dg[0].id).some(p => p.kind === "phase" && /Facelift/.test(p.label)), dg && dg.map(g => g.label).join(", "));
check("which runs as long as its facelift", dg && dg[0].end === 2001, dg && dg[0].end);
const p106 = plate("Peugeot", "106"), g106 = p106 && gens(p106);
check("the Peugeot 106 is one car, named 106, with its two phases", g106 && g106.length === 1 && g106[0].label === "106" && LF.phasesOf(g106[0].id).length === 2, g106 && g106.map(g => g.label).join(", "));
const ioniq = plate("Hyundai", "Ioniq"), gi = ioniq && gens(ioniq);
check("the Ioniq's hybrid, electric and plug-in versions are versions of one car", gi && gi.length === 1 && LF.phasesOf(gi[0].id).filter(p => p.kind === "variant").length === 3);
const avenger = plate("Dodge", "Avenger");
check("two cars of different years are not folded: the Avenger's 1995 coupe and 2008 sedan", avenger && gens(avenger).length >= 2);
const xj2 = DATA.nodes.find(n => n.id === "llm-llm-related-jaguar-xj6-series-ii");
check("a folded version's engines are its generation's: XJ-Coupé's V12 on the XJ Series II",
  DATA.links.some(l => !l.retired && l.type === "fitted" && idOf(l.target) === xj2.id));
window.CarWeb.openDetail(g106[0]);
const meta = window.document.querySelector("#detail .dt-meta").textContent;
check("the card lists the phases with their years", /phases: Phase I 1991–1996 · Phase II 1996–2003/.test(meta), meta);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
