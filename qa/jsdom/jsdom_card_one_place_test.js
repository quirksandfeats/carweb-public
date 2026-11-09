// One car in one place on a card: a generation over its own nameplate, a shared platform over "related to" (9 Nov 2026).
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
// The card's rows, by section, as node ids (each row's click target).
let ids = {};
function sections(n) {
  window.CarWeb.openDetail(n);
  const out = {}; let cur = null; ids = {};
  for (const el of window.document.querySelectorAll(".dt-connections > *")) {
    if (el.tagName === "H4") { cur = el.textContent; out[cur] = []; continue; }
    if (cur) out[cur].push(el.textContent.trim());
    if (cur) (ids[cur] = ids[cur] || []).push(el.dataset.id);
  }
  return out;
}
const nameOf = o => o.make + " " + o.label;
const europaS = byId.get("m-lotus-europa-s");
const s = europaS ? sections(europaS) : {};
const plat = s["shares platform with"] || [], rel = s["related to"] || [];
check("the Europa S card lists the Exige once, as the Exige Series 2", plat.some(r => /^Lotus Exige Series 2/.test(r)) && ![...plat, ...rel].some(r => /^Lotus Exige \d{4}$/.test(r)), JSON.stringify(s));
check("the Europa S succeeds the Esprit S4, not the Esprit and the Esprit S4", (s["succeeds"] || []).some(r => /Esprit S4/.test(r)) && !(s["succeeds"] || []).some(r => /^Lotus Esprit \d{4}$/.test(r)), JSON.stringify(s["succeeds"]));
check("no car under both 'shares platform with' and 'related to' on the Europa S", !rel.some(r => plat.some(p => p.split(" ").slice(0, 3).join(" ") === r.split(" ").slice(0, 3).join(" "))), JSON.stringify({ plat, rel }));
// Every car: no row under both sections, and no nameplate beside one of its own generations.
let both = 0, pair = 0, seen = 0, first = "", firstPair = "";
const cars = DATA.nodes.filter(n => !n.retired && (n.type === "model" || n.type === "family"));
for (const n of cars.filter((x, i) => i % 7 === 0)) {
  window.CarWeb.openDetail(n);
  seen++;
  const out = sections(n);
  // A nameplate listed beside one of its own generations.
  for (const [verb, list] of Object.entries(ids)) {
    if (verb === "part of") continue;
    const set = new Set(list);
    const hit = list.map(id => byId.get(id)).find(o => o && o.familyOf && set.has(o.familyOf));
    if (hit) { pair++; if (!firstPair) firstPair = `${nameOf(n)} · ${verb}: ${nameOf(hit)}`; }
  }
  const P = out["shares platform with"] || [], R = out["related to"] || [];
  if (R.some(r => P.includes(r))) { both++; if (!first) first = `${nameOf(n)}: ${R.filter(r => P.includes(r)).join(", ")}`; }
}
check(`no car is listed under both sections (${seen} cards)`, both === 0 && seen > 1000, first);
check(`no nameplate beside one of its own generations in a list (${seen} cards)`, pair === 0, firstPair);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
