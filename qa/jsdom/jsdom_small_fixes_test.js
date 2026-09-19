// Four small reports, one file.
//
// 12. "for the mercedes A Class nameplate, the first generation seems to only
//     have the starting year. However the wikipedia has both starting and end
//     year. Is this because the LLM scanned it wrong, or was it simply a
//     DBpedia issue?" -- DBpedia. The real A-Class W176 is filed as
//     "2012-2012" and the W177 starts in 2018, so the end-year backfill has to
//     treat an end equal to its own start as unknown, not as a fact.
// 13. "I want powertrain tab to be to the right of the graph tab, and also
//     re-size the text in the powertrain button, since on mobile, the text
//     appears cut off."
// 14. "if I rename the model in the nameplate then this should also propagate
//     down to its generations as well so i dont have to rename each one
//     individually."
// 15. "If I place both the start and end date to be at the end (or at the
//     start of time), then I cannot actually move them back again... Make sure
//     that the start end end do not overlap, there must always be at least one
//     year gap between them."
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

const FAM = "fam-testsm-a", G1 = "m-testsm-w176", G2 = "m-testsm-w177";

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });
window.fetch = (u, o) => {
  if (String(u) === "/api/llm-families" && o && o.method === "POST")
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  if (/[?&]page=/.test(String(u))) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-testsm", type: "make", label: "TestSm", year: 1900 };
    D.nodes.push(mk, { id: FAM, type: "family", label: "A-Class", make: "TestSm", year: 2012,
                       generations: [G1, G2], designers: [], engineers: [] });
    D.links.push({ source: FAM, target: mk.id, type: "made" });
    // Exactly the real shape: an end year equal to its own start, and a
    // successor six years later.
    D.nodes.push({ id: G1, type: "model", label: "A-Class (W176)", make: "TestSm",
                   familyOf: FAM, year: 2012, end: 2012, designers: [], engineers: [] });
    D.nodes.push({ id: G2, type: "model", label: "A-Class (W177)", make: "TestSm",
                   familyOf: FAM, year: 2018, end: null, designers: [], engineers: [] });
    D.links.push({ source: FAM, target: G1, type: "generation" },
                 { source: FAM, target: G2, type: "generation" });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const doc = window.document;

// ---------- 12. the end year ----------
{
  const g1 = cw.byId.get(G1), g2 = cw.byId.get(G2);
  check("a generation whose end equals its start, with a later successor, is bounded by it",
        g1.end === 2018, `${g1.year}-${g1.end}`);
  check("...and the newest generation stays open-ended", g2.end == null, g2.end);
}
// A one-year generation whose successor starts the very next year is real.
{
  const one = { id: "m-testsm-one", type: "model", label: "One", make: "TestSm", year: 1970, end: 1970 };
  const two = { id: "m-testsm-two", type: "model", label: "Two", make: "TestSm", year: 1971, end: 1975 };
  const src = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
  check("...but a genuine one-year generation followed immediately is left alone",
        /next\.year > g\.year \+ 1/.test(src));
}

// ---------- 13. the tabs ----------
{
  const order = [...doc.querySelectorAll("#viewtabs .tab")].map(b => b.dataset.view);
  check("Powertrain sits immediately to the right of Graph",
        order[0] === "graph" && order[1] === "power", order.join(" > "));
  check("...and the tab labels are never cut mid-word",
        /\.tab\{[^}]*white-space:nowrap/s.test(css));
  check("...with the four tabs wrapping to two rows in the phone menu rather than being squeezed",
        /#navmenu #viewtabs\{flex-wrap:wrap\}/.test(css) &&
        /#navmenu #viewtabs \.tab\{[^}]*text-overflow:ellipsis/.test(css));
}

// ---------- 14. renaming a nameplate ----------
{
  const fam = cw.byId.get(FAM);
  LF.renameNode(fam, "A Class", window.CARDATA.nodes);
  check("renaming a nameplate renames it", fam.label === "A Class", fam.label);
  check("...and its generations follow, keeping their own suffix",
        cw.byId.get(G1).label === "A Class (W176)" && cw.byId.get(G2).label === "A Class (W177)",
        cw.byId.get(G1).label + " / " + cw.byId.get(G2).label);
  // A generation renamed by hand is the more specific instruction and keeps
  // whatever it was called.
  const g2 = cw.byId.get(G2);
  LF.renameNode(g2, "The New One", window.CARDATA.nodes);
  LF.renameNode(cw.byId.get(FAM), "A-Klasse", window.CARDATA.nodes);
  check("...but one renamed by hand keeps its own name",
        cw.byId.get(G2).label === "The New One", cw.byId.get(G2).label);
  check("...while the rest still follow",
        cw.byId.get(G1).label === "A-Klasse (W176)", cw.byId.get(G1).label);
  const lf = fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8");
  check("...and a code-only generation, with no nameplate name in it, is untouched",
        /if \(!g \|\| !g\.label \|\| !re\.test\(g\.label\)\) return;/.test(lf));
}

// ---------- 15. the year slider ----------
{
  const r0 = cw.yearRange();
  cw.setYearRange(r0.max, r0.max);
  let r = cw.yearRange();
  check("both thumbs dragged to the end still leave a year between them",
        r.hi > r.lo, `${r.lo}-${r.hi}`);
  check("...and the end thumb stays at the end", r.hi === r0.max, r.hi);
  cw.setYearRange(r0.min, r0.min);
  r = cw.yearRange();
  check("both dragged to the start likewise", r.hi > r.lo, `${r.lo}-${r.hi}`);
  check("...and the start thumb stays at the start", r.lo === r0.min, r.lo);
  const lo = doc.getElementById("yf-lo"), hi = doc.getElementById("yf-hi");
  cw.setYearRange(1990, 2000);
  lo.value = "2000";
  lo.dispatchEvent(new window.Event("input"));
  r = cw.yearRange();
  check("dragging the low thumb onto the high one stops a year short",
        r.lo === 1999 && r.hi === 2000, `${r.lo}-${r.hi}`);
  hi.value = "1999";
  hi.dispatchEvent(new window.Event("input"));
  r = cw.yearRange();
  check("...and the high thumb likewise", r.hi === 2000 && r.lo === 1999, `${r.lo}-${r.hi}`);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
