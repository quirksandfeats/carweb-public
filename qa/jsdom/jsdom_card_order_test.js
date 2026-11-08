// The car card lists its sections in one order on every card (8 Nov 2026).
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
const idOf = v => (typeof v === "string" ? v : v.id);
const N = id => DATA.nodes.find(n => n.id === id);
const named = (id, type = "platform") => DATA.links.filter(l => !l.retired && !l.mirror && l.type === type && (idOf(l.source) === id || idOf(l.target) === id))
  .map(l => idOf(l.source) === id ? idOf(l.target) : idOf(l.source));
const ORDER = ["made by", "maker of", "part of", "previous generation", "next generation", "succeeds", "succeeded by",
  "drawn by", "engineered by", "designed", "engineered", "shares platform with", "related to", "linked to"];
const rank = v => { const i = ORDER.findIndex(o => v === o || v.startsWith(o + " ·")); return i < 0 ? ORDER.length : i; };
const idOf2 = v => (typeof v === "string" ? v : v.id);
// Every car with both a predecessor and a successor, and a sample of the rest.
const both = DATA.nodes.filter(n => !n.retired && (n.type === "model" || n.type === "family") &&
  ["succession", "gensucc"].every(t => DATA.links.some(l => !l.retired && l.type === t && (idOf2(l.source) === n.id || idOf2(l.target) === n.id))));
const sample = both.concat(DATA.nodes.filter((n, i) => !n.retired && i % 97 === 0));
let bad = 0, seen = 0, first = "";
for (const n of sample) {
  window.CarWeb.openDetail(n);
  const heads = [...window.document.querySelectorAll(".dt-connections h4")].map(h => h.textContent);
  seen++;
  for (let i = 1; i < heads.length; i++) if (rank(heads[i]) < rank(heads[i - 1])) { bad++; if (!first) first = `${n.make || ""} ${n.label}: ${heads.join(" / ")}`; break; }
}
check(`card sections keep one order (${seen} cards)`, bad === 0 && seen > 100, first);
window.CarWeb.openDetail(DATA.nodes.find(n => n.id === "llm-m-lincoln-mark-series-mark-viii") || both[0]);
const h = [...window.document.querySelectorAll(".dt-connections h4")].map(x => x.textContent);
check("succeeds comes before succeeded by", !(h.includes("succeeds") && h.includes("succeeded by")) || h.indexOf("succeeds") < h.indexOf("succeeded by"), h.join(" / "));

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
