// Another maker's car read as a generation goes to the car of that name (9 Nov 2026).
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
const byId = new Map(DATA.nodes.map(n => [n.id, n]));
const plate = (make, label) => DATA.nodes.find(n => !n.retired && n.type === "family" && n.make === make && n.label === label);
const labels = p => (p.generations || []).map(id => byId.get(id)).filter(g => g && !g.retired).map(g => g.label);
check("the list is loaded", Object.keys(window.OTHER_MAKE_GENERATIONS || {}).length >= 30);
const clip = plate("Nissan", "Clipper");
check("the Clipper keeps no Suzuki or Mitsubishi generations", clip && !labels(clip).some(l => /Suzuki|Mitsubishi/.test(l)), clip && labels(clip).join(", "));
const f128 = plate("Fiat", "128");
check("the SEAT 128 is not a Fiat 128 generation", f128 && !labels(f128).some(l => /SEAT/.test(l)));
const rsx = plate("Acura", "RSX");
check("a platform is no generation: the RSX's Zero platform", rsx && !labels(rsx).some(l => /platform/i.test(l)));
const crown = plate("Toyota", "Crown");
check("a generation the article numbers stays: Toyopet Crown", crown && labels(crown).some(l => /Toyopet Crown/.test(l)));
// Found through Wikipedia's own title or redirect (9 Nov 2026).
check("the Zastava Skala is no Fiat 128 generation", f128 && !labels(f128).some(l => /Zastava/.test(l)), f128 && labels(f128).join(", "));
const antara = plate("Opel", "Antara");
check("the Holden Captiva 5 and 7 leave the Antara", antara && !labels(antara).some(l => /Holden/.test(l)), antara && labels(antara).join(", "));
const corsair = plate("Ford", "Corsair");
check("the Edsel Corsairs go to the Edsel Corsair's generations", corsair && !labels(corsair).some(l => /Edsel/.test(l)) &&
  byId.get("llm-m-ford-corsair-edsel-corsair-1958").foldedInto === "llm-m-edsel-corsair-first-generation");
const cab = plate("Nissan", "Cabstar");
check("another nameplate's code goes to that generation: Atlas F22 -> Atlas F22/H40", cab && !labels(cab).some(l => /Atlas/.test(l)) &&
  byId.get("llm-llm-related-nissan-cabstar-atlas-f22").foldedInto === "llm-llm-related-nissan-atlas-f22-h40");
const transit = plate("Ford", "Transit");
check("the same maker's car with an article of its own: Transit City", transit && !labels(transit).some(l => /Transit City/.test(l)));
const maloo = DATA.nodes.find(n => !n.retired && n.type === "family" && /Maloo/.test(n.label));
check("a nameplate built on a run of another maker's cars keeps them: HSV Maloo", maloo && labels(maloo).filter(l => /Commodore/.test(l)).length >= 5, maloo && labels(maloo).join(", "));
const r128 = byId.get("m-zastava-skala");
check("the Skala sits on the Fiat 128's platform, not the Nasr's", DATA.links.some(l => !l.retired && l.type === "platform" &&
  [l.source.id || l.source, l.target.id || l.target].sort().join("|") === ["m-zastava-skala", "llm-m-fiat-128-fiat-128"].sort().join("|")) && r128 && !r128.retired);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
