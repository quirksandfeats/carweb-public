// "Re-read Engines" reaches zero: folded generations and reads set aside by this reader are not due (10 Nov 2026).
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
// The same reads, as a later load would leave them once this reader had set them aside.
const marked = JSON.parse(JSON.stringify(shipped));
Object.values(marked.engineScans || {}).forEach(r => { if (r.v === 0 && r.staleReason) r.staleFromV = 8; });
function boot(store) {
  for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
    if (/llm_families_data/.test(f)) continue;
    if (f === "llm_families.js") window.LLM_FAMILIES = Object.assign({}, store, { __serverAvailable: false });
    ev(f);
  }
  window.CarWeb.boot();
  return window.LlmFamilies.engineReadsDue(window.CARDATA.nodes);
}
const due = boot(marked);
const label = n => (n.make || "") + " " + n.label;
check("a nameplate whose only unread generations are folded away is not due: the BMW Z1", !due.some(n => label(n) === "BMW Z1"), due.slice(0, 10).map(label).join(", "));
check("a read this reader set aside as covering several cars is not due again: the Buick Estate", !due.some(n => label(n) === "Buick Estate"));
check("nothing re-read by this reader stays due for good", due.length <= 5, due.length + ": " + due.slice(0, 10).map(label).join(", "));
const rec = Object.entries(window.LLM_FAMILIES.engineScans || {}).find(([, r]) => r.v === 0 && r.staleReason);
check("a read set aside says which reader made it", !rec || rec[1].staleFromV != null, rec && JSON.stringify(rec[1]).slice(0, 160));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
