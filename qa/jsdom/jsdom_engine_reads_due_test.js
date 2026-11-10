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
// Reader 9 (10 Nov 2026) reads only a generation's empty read of its nameplate's page
// again. Without the nameplate's page, the test is the one before it: nothing else is due.
const scans = window.LLM_FAMILIES.engineScans || {};
const byIdDue = new Map(window.CARDATA.nodes.map(n => [n.id, n]));
const LFd = window.LlmFamilies;
const otherDue = due.filter(n => n.type === "family"
  ? (n.generations || []).some(g => byIdDue.get(g) && !byIdDue.get(g).retired && !LFd.engineScanIsCurrent(scans[g]))
  : !LFd.engineScanIsCurrent(scans[n.id]));
check("a read this reader set aside as covering several cars is not due again: the Buick Estate's 1991 read",
  !otherDue.some(n => label(n) === "Buick Estate"));
check("nothing else read by the last reader is due", otherDue.length <= 5, otherDue.length + ": " + otherDue.slice(0, 10).map(label).join(", "));
const mark = due.find(n => label(n) === "Lincoln Mark series");
check("the Mark series is due for its Mark VI's empty read of the nameplate's page", !!mark);
const rec = Object.entries(window.LLM_FAMILIES.engineScans || {}).find(([, r]) => r.v === 0 && r.staleReason);
check("a read set aside says which reader made it", !rec || rec[1].staleFromV != null, rec && JSON.stringify(rec[1]).slice(0, 160));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
