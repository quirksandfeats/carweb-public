// Verifies the Graph-only year-range filter (task #43).
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;

function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { throw new Error("no server in this test"); };
};

global.window = window;
global.document = window.document;
function loadScript(file) { window.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
window.LLM_FAMILIES = { families: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

window.CarWeb.boot();
const cw = window.CarWeb;

// ---------- default range ----------
const r0 = cw.yearRange();
console.log("data year range:", JSON.stringify(r0));
check("default lower bound is 2000", r0.lo === 2000, r0.lo);
check("default upper bound is the data's max/present year", r0.hi === r0.max, `${r0.hi} vs ${r0.max}`);

// ---------- build a small synthetic neighborhood: make -> family -> 2 generations, + a designer ----------
function addNode(n) { cw.nodes.push(n); cw.byId.set(n.id, n); cw.adj.set(n.id, []); n.x = n.x ?? 0; n.y = n.y ?? 0; }
function addLink(source, target, type) {
  const l = { source, target, type };
  l.sn = cw.byId.get(source); l.tn = cw.byId.get(target);
  cw.links.push(l);
  cw.adj.get(source).push({ n: l.tn, l });
  cw.adj.get(target).push({ n: l.sn, l });
}

const MAKE = "test-make", FAM = "test-fam", GEN1 = "test-gen1", GEN2 = "test-gen2", PERSON = "test-designer";
const OLD_STANDALONE = "test-standalone-1980-2000";
addNode({ id: MAKE, type: "make", label: "TestCo", country: "Testland" });
addNode({ id: FAM, type: "family", make: "TestCo", label: "Multigen", year: 1980, end: null, generations: [GEN1, GEN2] });
addNode({ id: GEN1, type: "model", make: "TestCo", label: "Multigen Mk1", year: 1980, end: 1985, familyOf: FAM });
addNode({ id: GEN2, type: "model", make: "TestCo", label: "Multigen Mk2", year: 1985, end: 1995, familyOf: FAM });
addNode({ id: PERSON, type: "person", label: "Test Designer", roles: ["designer"] });
addNode({ id: OLD_STANDALONE, type: "model", make: "TestCo", label: "Ranger", year: 1980, end: 2000 });
addLink(MAKE, FAM, "made");
addLink(MAKE, OLD_STANDALONE, "made");
addLink(FAM, GEN1, "generation");
addLink(FAM, GEN2, "generation");
addLink(PERSON, GEN2, "designed"); // only gen2 has a designer link

// ---------- sanity check from the user: a 1980-2000 run stays visible at lo=1990 ----------
cw.setYearRange(1990, r0.max);
check("1980-2000 standalone model overlaps [1990,present] -- stays visible", cw.passesYearFilter(cw.byId.get(OLD_STANDALONE)));

// ---------- collapsed family: checked against its OWN aggregate span ----------
check("family not expanded by default", !cw.isFamilyExpanded(FAM));
check("collapsed family (1980-present aggregate) overlaps [1990,present] -- visible", cw.passesYearFilter(cw.byId.get(FAM)));

// ---------- expanded: gen1 (1980-1985) entirely before lo=1990 is hidden; gen2 (1985-1995) stays ----------
cw.expandFamily(FAM);
check("gen1 (1980-1985) does NOT overlap [1990,present] -- excluded once expanded", !cw.passesYearFilter(cw.byId.get(GEN1)));
check("gen2 (1985-1995) DOES overlap [1990,present] -- stays visible", cw.passesYearFilter(cw.byId.get(GEN2)));
check("nodeInLayer also lets gen2 through (family is expanded)", cw.nodeInLayer(cw.byId.get(GEN2)));

// ---------- make/person visibility cascades from their in-range neighbors ----------
check("make has an in-range neighbor (the standalone Ranger, or the family) -- visible", cw.passesYearFilter(cw.byId.get(MAKE)));
check("designer is only linked to gen2, which is in range -- visible", cw.passesYearFilter(cw.byId.get(PERSON)));

// Now narrow the range so NEITHER generation overlaps, and the standalone doesn't either
cw.setYearRange(1996, r0.max);
check("gen1 (1980-1985) still excluded", !cw.passesYearFilter(cw.byId.get(GEN1)));
check("gen2 (1985-1995) now also excluded (ends before 1996)", !cw.passesYearFilter(cw.byId.get(GEN2)));
check("designer's only link (gen2) now out of range -- designer hidden too", !cw.passesYearFilter(cw.byId.get(PERSON)));
check("standalone Ranger (1980-2000) still overlaps [1996,present] -- stays visible (make still visible via it)",
  cw.passesYearFilter(cw.byId.get(OLD_STANDALONE)) && cw.passesYearFilter(cw.byId.get(MAKE)));

// ---------- explicit navigation auto-widens the range ----------
cw.setYearRange(2010, r0.max); // now GEN1/GEN2/OLD_STANDALONE are all well out of range
check("gen1 excluded before navigating to it", !cw.passesYearFilter(cw.byId.get(GEN1)));
cw.goto(GEN1);
const widened = cw.yearRange();
check("navigating to gen1 (year 1980) widened the lower bound to include it", widened.lo <= 1980, widened.lo);
check("gen1 is now visible after the auto-widen", cw.passesYearFilter(cw.byId.get(GEN1)));

// ---------- missing year data is never hidden ----------
const NO_YEAR = "test-no-year";
addNode({ id: NO_YEAR, type: "model", make: "TestCo", label: "Mystery" }); // no .year at all
cw.setYearRange(2020, r0.max);
check("a model with no year data at all is never hidden by the filter", cw.passesYearFilter(cw.byId.get(NO_YEAR)));

// ---------- the slider UI itself ----------
const yfBtn = window.document.getElementById("yf-lo");
const yfHi = window.document.getElementById("yf-hi");
check("the lo/hi range inputs exist in the DOM", !!yfBtn && !!yfHi);
check("inputs' min/max were set from the data's real year range", +yfBtn.min === r0.min && +yfHi.max === r0.max, `${yfBtn.min}/${yfHi.max} vs ${r0.min}/${r0.max}`);
yfBtn.value = 1995;
yfBtn.dispatchEvent(new window.Event("input"));
check("dragging the lo thumb updates the actual filter range", cw.yearRange().lo === 1995, cw.yearRange().lo);
const loLabel = window.document.getElementById("yf-lo-label");
check("the lo label reflects the new value", loLabel.textContent === "1995", loLabel.textContent);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
