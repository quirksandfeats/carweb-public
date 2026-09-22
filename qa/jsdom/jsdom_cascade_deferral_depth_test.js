// Real user report: "I queued up the mercedes c class to be scanned ... the
// number of cars in the queue increased all the way to over 100." With the
// cascade depth at 1.
//
// A car whose article belongs to another car defers to it and, if that owner
// was never read, starts the owner's check. That check started with no
// recorded distance, so it counted as the car the user clicked (depth 0), and
// its partners passed the budget again; each of them deferring kicked ITS
// owner at depth 0 in turn. The walk renewed its allowance at every
// deferral. The owner reads the same article, so it is at the same distance.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
const fakeCtx = () => new Proxy({ measureText: () => ({ width: 10 }) },
  { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1; window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
// Every article fetch answers with a page titled after what was asked; the
// model is never reached (the owner's check fails fast, which is fine -- only
// the distance it was started at matters here).
window.fetch = (url) => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": "{{Infobox automobile}}" } } }) });
  }
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    D.nodes.push({ id: "mk-t-chev", type: "make", label: "Chevrolet", year: 1911 });
    D.nodes.push({ id: "m-t-clicked", type: "model", label: "Clicked", make: "Chevrolet", wp: "Chevrolet Clicked", year: 1990 });
    // The partner, and the car that owns its article
    D.nodes.push({ id: "m-t-acadian", type: "model", label: "Acadian", make: "Chevrolet", wp: "Testmobile Chevette", year: 1976 });
    D.nodes.push({ id: "m-t-chevette", type: "model", label: "Chevette", make: "Testmobile", wp: "Testmobile Chevette", year: 1975 });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, settings: { cascadeMaxDepth: 1 }, __serverAvailable: true };
  }
  window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
}
const cw = window.CarWeb; cw.boot();
const LF = window.LlmFamilies;

(async () => {
  check("a car started on behalf of another is one hop further out",
        LF.placeInCascade("m-t-acadian", "m-t-clicked") === 1, LF.cascadeDepthOf("m-t-acadian"));
  check("...and a distance once given is kept", LF.placeInCascade("m-t-acadian", "m-t-chevette") === 1);

  const r = await LF.sameArticleOwner(cw.byId.get("m-t-acadian"), cw.nodes);
  check("(fixture) the partner defers to the car that owns its article",
        r && r.owner && r.owner.id === "m-t-chevette", r && r.owner && r.owner.id);
  check("the owner's check starts at the partner's distance, not as a new starting point",
        LF.cascadeDepthOf("m-t-chevette") === 1, LF.cascadeDepthOf("m-t-chevette"));
  check("...so, at depth 1, the owner's own partners are not followed",
        !LF.cascadeAllowedFrom("m-t-chevette"));

  console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
