// Concept cars read as generations are cars that share the nameplate's name (9 Nov 2026).
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
const byId = new Map(DATA.nodes.map(n => [n.id, n]));
const linked = (a, b, type) => DATA.links.some(l => !l.retired && l.type === type && [idOf(l.source), idOf(l.target)].sort().join("|") === [a, b].sort().join("|"));
check("the list is loaded", Object.keys(window.CONCEPT_CARS || {}).length >= 15);
const sf = byId.get("llm-llm-related-oldsmobile-starfire-concept-car"), plate = byId.get("llm-related-oldsmobile-starfire");
check("the 1953 Starfire dream car is no generation of the Starfire", sf && !sf.retired && !sf.familyOf && !(plate.generations || []).includes(sf.id));
check("it shares the Starfire's name", linked(sf.id, plate.id, "name"));
const gtrx = byId.get("llm-m-holden-torana-gtr-x"), lc = byId.get("llm-m-holden-torana-lc"), lj = byId.get("llm-m-holden-torana-lj");
check("a concept found by its card's type: the Torana GTR-X", gtrx && !gtrx.familyOf && gtrx.concept === true);
check("the chain closes over it: Torana LC -> LJ", lc && lj && linked(lc.id, lj.id, "gensucc"));
const corniche = DATA.nodes.find(n => !n.retired && n.make === "Rolls-Royce" && n.label === "Corniche Corniche");
check("a production car whose history opens with a prototype stays: the 1971 Corniche", !corniche || !!corniche.familyOf);
check("a far mention goes to the generation of its years: Vega with the 1975 Starfire",
  linked("m-chevrolet-vega", "llm-llm-related-oldsmobile-starfire-second-generation", "platform") && !linked("m-chevrolet-vega", sf.id, "platform"));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
