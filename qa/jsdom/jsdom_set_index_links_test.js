// A car whose link is a list of the cars sharing its name reads its own article (10 Nov 2026).
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
// A link chosen by hand wins: the Ford Prefect's, set to another page.
shipped.wpLinks = Object.assign({}, shipped.wpLinks, { "m-ford-prefect": "Ford Prefect (car) hand" });
shipped.wpLinksChosen = Object.assign({}, shipped.wpLinksChosen, { "m-ford-prefect": true });
// Readings off the list pages, as they stood before the rule (the re-read of 10 Nov 2026 cleared them from the store).
shipped.families = Object.assign({}, shipped.families, {
  "m-bmw-i3": { status: "none", sourceTitle: "BMW i3", proposal: { hasMultipleGenerations: false, generations: [] } },
  "m-ford-prefect": { status: "none", sourceTitle: "Ford Prefect", proposal: { hasMultipleGenerations: false, generations: [] } } });
shipped.engineScans = Object.assign({}, shipped.engineScans, { "m-bmw-i3": { sourceTitle: "BMW i3", status: "no-engines", engines: [], unlinked: [], v: 7 } });
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") window.LLM_FAMILIES = Object.assign({}, shipped, { __serverAvailable: false });
  ev(f);
}
window.CarWeb.boot();
const byId = new Map(window.CARDATA.nodes.map(n => [n.id, n]));
check("the list is loaded", Object.keys(window.SET_INDEX_LINKS || {}).length >= 3);
check("the 2013 BMW i3 reads its own article, not the list of i3s", byId.get("m-bmw-i3").wp === "BMW i3 (hatchback)", byId.get("m-bmw-i3").wp);
check("the Buick Verano reads the North American car's article", byId.get("m-buick-verano").wp === "Buick Verano (North America)");
check("a link chosen by hand wins", byId.get("m-ford-prefect").wp === "Ford Prefect (car) hand", byId.get("m-ford-prefect").wp);
check("the 2026 i3 keeps its own link", byId.get("m-bmw-i3-na0").wp === "BMW i3 (NA0)");
const LF = window.LlmFamilies;
check("what was read off the list page goes: the i3's verdict and engine read", !LF.entryFor("m-bmw-i3") && !LF.engineScanEntryFor("m-bmw-i3"),
  JSON.stringify([LF.entryFor("m-bmw-i3"), LF.engineScanEntryFor("m-bmw-i3")]).slice(0, 200));
check("a car whose link was chosen by hand keeps its readings", !!LF.entryFor("m-ford-prefect"));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
