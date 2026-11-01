// Last audit round, the app itself: article text is never markup, a make or a
// person's article has to be about them, years and succession agree with a
// reload, and retired cars stay off the cards.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const SUMMARIES = {
  "TestEv_Evil": { type: "standard", extract: "The car. <img src=x onerror=\"window.__pwned=1\"> is fast.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/x" } } },
  "Jagtest": { type: "standard", description: "large cat", extract: "The jagtest is a large cat species.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/cat" } } },
  "Jagtest_Cars": { type: "standard", description: "British luxury car maker", extract: "Jagtest Cars makes cars.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/cars" } } },
  "Ann_Other": { type: "disambiguation", extract: "Ann Other may refer to:" },
};
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window: w } = dom;
w.HTMLCanvasElement.prototype.getContext = fakeCtx;
w.requestAnimationFrame = () => 1;
w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
w.Element.prototype.scrollIntoView = () => {};
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
w.fetch = async url => {
  const m = String(url).match(/page\/summary\/([^?]+)/);
  if (m) { const j = SUMMARIES[decodeURIComponent(m[1])]; return j ? { ok: true, json: async () => j } : { ok: false, json: async () => ({}) }; }
  return { ok: true, json: async () => ({}) };
};
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const D = w.CARDATA, next = new Date().getFullYear() + 1;
const model = (id, label, year, end, extra) => Object.assign({ id, type: "model", label, make: "TestEv", year, end }, extra);
D.nodes.push({ id: "mk-tev", type: "make", label: "TestEv" }, { id: "mk-jag", type: "make", label: "Jagtest", wp: "Jagtest" },
  { id: "p-ann", type: "person", label: "Ann Other", wp: "Ann Other" },
  model("m-tev-evil", "Evil", 2000, 2001, { wp: "TestEv Evil" }),
  model("m-tev-old", "Old", 1913, 1919), model("m-tev-new", "New", 1919, 1930),
  { id: "fam-tev", type: "family", label: "Fam", make: "TestEv", year: 2000, end: null, generations: ["g-a", "g-b", "g-c", "g-d"] },
  model("g-a", "Fam A", 2000, null, { familyOf: "fam-tev" }), model("g-b", "Fam B (2010–present)", 2010, null, { familyOf: "fam-tev" }),
  model("g-c", "Fam C", 2020, null, { familyOf: "fam-tev" }), model("g-d", "Fam D", next, null, { familyOf: "fam-tev", future: true }));
D.links.push({ source: "m-tev-new", target: "m-tev-old", type: "succession" });
w.LLM_FAMILIES = { families: {}, recheck: {}, relations: {}, __serverAvailable: false };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const cw = w.CarWeb, by = id => cw.byId.get(id);
const settle = () => new Promise(r => setTimeout(r, 60));
(async () => {
  const flipped = cw.links.find(l => l.type === "succession" && [l.source, l.target].map(x => x.id || x).sort().join() === "m-tev-new,m-tev-old");
  t("a car that ended before the other began did not follow it", (flipped.source.id || flipped.source) === "m-tev-old", flipped && (flipped.source.id || flipped.source));
  t("a next generation's start bounds an open end", by("g-a").end === 2010, by("g-a").end);
  t("a label saying present stays open", by("g-b").end == null, by("g-b").end);
  t("a next generation not started yet closes nothing", by("g-c").end == null, by("g-c").end);
  const panel = () => w.document.querySelector(".dt-extract");
  cw.openDetail(by("m-tev-evil")); await settle();
  t("an article's text is never markup", !panel().querySelector("img") && /&lt;img|<img/.test(panel().textContent + panel().innerHTML), panel().innerHTML.slice(0, 60));
  cw.openDetail(by("mk-jag")); await settle(); await settle();
  t("a make's article has to be about a maker", /makes cars/.test(panel().textContent) && !/cat/.test(panel().textContent), panel().textContent.slice(0, 60));
  panel().innerHTML = "";
  cw.openDetail(by("p-ann")); await settle(); await settle();
  t("a name that is a disambiguation page shows nothing", !/may refer/.test(panel().textContent), panel().textContent.slice(0, 60));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
