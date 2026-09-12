// backfillGenerationEnds() bounds every generation of a family except the
// last one, using the next generation's start year -- "1968-" sitting next to
// a generation that starts in 1972 means 1972, not "still in production".
//
// The bug this covers is the half that was missing: it never touched the
// FAMILY node's own end year. build_family_layer.py can only close a family
// when every member already had an end year, so one open-ended middle
// generation left fam.end null -- and the family then rendered as still in
// production against its own evidence. 20 real families were in that state:
// BMW 5 Series (last generation ends 2023), Camaro (2023), Thunderbird
// (2005), Taurus (2019), Accord (2017), Grand Cherokee (2022).
//
// The family is over exactly when its LAST generation is over, so a family
// whose newest generation is genuinely open-ended must still stay open.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
};

function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

// CLOSED: a middle generation with no end year, a last generation that ended.
// OPEN:   same shape, but the last generation is still in production.
const CLOSED = "fam-test-closed", OPEN = "fam-test-open";
function seed(DATA) {
  const mk = { id: "mk-testend", type: "make", label: "TestEndMarque", year: 1950 };
  DATA.nodes.push(mk);
  const gen = (id, year, end, fam) => ({ id, type: "model", label: id, make: "TestEndMarque",
    year, end, familyOf: fam, designers: [], engineers: [] });
  const c1 = gen("m-test-closed-g1", 1990, null, CLOSED);
  const c2 = gen("m-test-closed-g2", 2000, null, CLOSED);
  const c3 = gen("m-test-closed-g3", 2010, 2020, CLOSED);
  const o1 = gen("m-test-open-g1", 1995, null, OPEN);
  const o2 = gen("m-test-open-g2", 2005, null, OPEN);
  const famClosed = { id: CLOSED, type: "family", label: "Closed", make: "TestEndMarque",
    year: 1990, end: null, designers: [], engineers: [],
    generations: [c1.id, c2.id, c3.id] };
  const famOpen = { id: OPEN, type: "family", label: "Open", make: "TestEndMarque",
    year: 1995, end: null, designers: [], engineers: [],
    generations: [o1.id, o2.id] };
  DATA.nodes.push(famClosed, famOpen, c1, c2, c3, o1, o2);
  [famClosed, famOpen].forEach(f => DATA.links.push({ source: f.id, target: mk.id, type: "made" }));
  [[CLOSED, c1], [CLOSED, c2], [CLOSED, c3], [OPEN, o1], [OPEN, o2]]
    .forEach(([f, g]) => DATA.links.push({ source: f, target: g.id, type: "generation" }));
}

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const loadScript = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
loadScript("d3.min.js");
loadScript("data.js");
seed(window.CARDATA);
window.LLM_FAMILIES = { families: {}, relations: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

const cw = window.CarWeb;
cw.boot();
const g = id => cw.byId.get(id);

check("a middle generation with no end year takes the next one's start year",
  g("m-test-closed-g1").end === 2000, g("m-test-closed-g1").end);
check("...and so does the one after it",
  g("m-test-closed-g2").end === 2010, g("m-test-closed-g2").end);
check("the last generation's own end year is left alone",
  g("m-test-closed-g3").end === 2020, g("m-test-closed-g3").end);
check("the FAMILY closes on its last generation's end year",
  g(CLOSED).end === 2020, g(CLOSED).end);
check("a family whose last generation is still in production stays open",
  g(OPEN).end == null, g(OPEN).end);
check("...but its earlier generation is still bounded",
  g("m-test-open-g1").end === 2005, g("m-test-open-g1").end);

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
