// A stored generation photo that is non-free or has a cut-short name is not shown (app/photo_skips.js, 8 Nov 2026).
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
const SK = window.PHOTO_SKIPS || {};
check("the list of skipped photos is loaded", Object.keys(SK).length >= 10, Object.keys(SK).length);
const skipped = DATA.nodes.filter(n => n.wikiFile && Object.prototype.hasOwnProperty.call(SK, n.wikiFile));
check("cars with a skipped photo exist in the graph", skipped.length > 0, skipped.length);
let shown = 0;
for (const n of skipped) {
  window.CarWeb.openDetail(n);
  const bg = window.document.querySelector(".dt-imgwrap").style.backgroundImage || "";
  if (bg.includes(encodeURIComponent(String(n.wikiFile).replace(/ /g, "_")))) shown++;
}
check("no card shows a skipped photo", shown === 0, shown + " of " + skipped.length);
const kept = DATA.nodes.find(n => n.wikiFile && !Object.prototype.hasOwnProperty.call(SK, n.wikiFile) && !n.dbphoto && !n.db);
window.CarWeb.openDetail(kept);
check("a free photo still shows", /Special:FilePath/.test(window.document.querySelector(".dt-imgwrap").style.backgroundImage), kept && kept.id);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
