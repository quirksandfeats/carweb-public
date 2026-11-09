// A nameplate split from another car's article under its own name gives the generations to that car (9 Nov 2026).
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
const live = id => { const n = byId.get(id); return n && !n.retired ? n : null; };
const gensOf = id => ((byId.get(id) || {}).generations || []).map(g => byId.get(g)).filter(g => g && !g.retired);
const linked = (a, b, type) => DATA.links.some(l => !l.retired && l.type === type && [idOf(l.source), idOf(l.target)].sort().join("|") === [a, b].sort().join("|"));
check("the list is loaded", Object.keys(window.BORROWED_PLATES || {}).length >= 20);
const lite = live("llm-related-toyota-liteace");
check("the LiteAce holds the generations its article gives, which the TownAce held", lite && lite.type === "family" && gensOf(lite.id).length === 8, lite && gensOf(lite.id).length);
check("the TownAce is another name for it", !live("llm-related-toyota-townace") && window.LlmFamilies.aliasesFor("llm-related-toyota-liteace").includes("Toyota TownAce"));
check("a generation's label carries the right name", gensOf("llm-related-toyota-liteace").every(g => /^LiteAce /.test(g.label)), gensOf("llm-related-toyota-liteace").map(g => g.label).join(", "));
const hatch = live("llm-related-mini-hatch");
check("the Mini Cooper's connections went with it to the Mini Hatch", hatch && DATA.links.some(l => !l.retired && l.type === "designed" && (idOf(l.source) === hatch.id || idOf(l.target) === hatch.id)));
check("the A3 Mk3 is the A3's third generation", !live("m-audi-a3-mk3") && byId.get("m-audi-a3-mk3").supersededBy === "llm-m-audi-a3-mk3-8v" && gensOf("llm-related-audi-a3").length === 4);
const fargo = live("plate-isuzufargo");
check("an article with no car of its name gets a nameplate: Isuzu Fargo", fargo && fargo.make === "Isuzu" && gensOf(fargo.id).length === 2);
check("another maker's badge stays its own car, related to it", live("llm-related-vauxhall-midi") && live("llm-related-vauxhall-midi").type === "model" && linked("llm-related-vauxhall-midi", "plate-isuzufargo", "related"));
const eev = live("llm-related-suzuki-e-every");
check("an electric version is a car of its own, without the whole article's years", eev && eev.type === "model" && eev.year == null && linked(eev.id, "llm-related-suzuki-every", "related"), eev && eev.year);
check("a car read from another nameplate's generation article loses those generations: Ford Contour",
  live("llm-related-ford-contour").type === "model" && gensOf("llm-related-ford-contour").length === 0 && !live("llm-llm-related-ford-contour-mk-i-mk-ii"));
check("a platform article gives no generations: General Motors C1XX", live("llm-related-general-motors-c1xx").type === "model" && !live("llm-llm-related-general-motors-c1xx-epsilon-i"));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
