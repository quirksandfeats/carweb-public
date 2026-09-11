// Three real user reports about Graph's camera/focus behavior:
// 1. "If I select a specific nameplate... the older generations don't
//    initially appear if the year slider does not encapsulate it. This is
//    intended. However, if I do try to move the slider to include the
//    older models, it doesn't actively update when I do, unless I click
//    again to focus." -- refreshFocus() now runs on every year-filter
//    change, not just live LLM mutations.
// 2. "If I unfocus from a particular car... I would prefer that it simply
//    unfocused but keeps me in the same position and zoom as before." --
//    clearFocus() no longer calls fitAll().
// 3. "The 'viewable window' is actually represented by the area where the
//    info card isn't... a tiny bit to the left of the left edge of the info
//    card." -- fitAll/flyToSet now reserve #detail's width when it's open.
//
// Every camera move in Graph (fitAll/flyToSet) uses an ANIMATED d3
// transition, which only actually progresses if requestAnimationFrame is a
// real scheduler -- a plain no-op stub (as most other jsdom tests in this
// suite use, since they never inspect the transform itself) leaves d3's
// internal timer queue never firing, so the transform silently never
// updates. This file specifically DOES need to inspect real transform
// values, so it wires requestAnimationFrame to real setTimeout-based
// scheduling and awaits past each animation's duration before reading
// cw.graphTransform().
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

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

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 4);
window.cancelAnimationFrame = id => clearTimeout(id);
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMk-ux");
if (!makeNode) { makeNode = { id: "mk-test-ux", type: "make", label: "TestMk-ux", year: 1950 }; DATA.nodes.push(makeNode); }
const FAM_ID = "fam-test-ux", G1_ID = "m-test-ux-g1", G2_ID = "m-test-ux-g2";
const fam = { id: FAM_ID, type: "family", label: "Ux", make: "TestMk-ux", year: 1990, end: null, designers: [], engineers: [], generations: [G1_ID, G2_ID] };
const g1 = { id: G1_ID, type: "model", label: "Ux I", make: "TestMk-ux", year: 1990, end: 2000, familyOf: FAM_ID };
const g2 = { id: G2_ID, type: "model", label: "Ux II", make: "TestMk-ux", year: 2010, end: null, familyOf: FAM_ID };
DATA.nodes.push(fam, g1, g2);
DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: FAM_ID, target: G1_ID, type: "generation" }, { source: FAM_ID, target: G2_ID, type: "generation" }, { source: G1_ID, target: G2_ID, type: "gensucc" });

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
const wait = ms => new Promise(r => setTimeout(r, ms));
const ANIM_WAIT = 1100; // longer than every animated transition's own duration (max 900ms, fitAll)

(async () => {
  console.log("\n--- year filter live-updates an already-active focus ---");
  cw.setYearRange(2005, cw.yearRange().max); // excludes G1 (1990-2000) from the start
  cw.goto(FAM_ID);
  await wait(ANIM_WAIT);
  check("family expanded by clicking it", cw.isFamilyExpanded(FAM_ID));
  let focusSet = cw.graphFocusSet();
  check("G2 (in range) is in the focus set", focusSet.has(G2_ID));
  check("G1 (out of range, 1990-2000) correctly excluded from the focus set at first", !focusSet.has(G1_ID));
  cw.setYearRange(1985, cw.yearRange().max); // widen to include G1, WITHOUT reclicking anything
  focusSet = cw.graphFocusSet();
  check("widening the year slider brings G1 into the STILL-ACTIVE focus set immediately, no reclick needed",
    focusSet.has(G1_ID));

  console.log("\n--- releasing focus keeps the camera where it was ---");
  await wait(ANIM_WAIT); // let the focusOn's own flyToSet settle before taking the "before" reading
  const beforeClear = cw.graphTransform();
  document.getElementById("clearfocus").onclick();
  check("focus actually cleared", !cw.graphFocusSet());
  await wait(ANIM_WAIT); // if clearFocus DID still call fitAll(), this is long enough for it to finish
  const afterClear = cw.graphTransform();
  check("camera scale (k) is unchanged by releasing focus", afterClear.k === beforeClear.k, `${afterClear.k} vs ${beforeClear.k}`);
  check("camera position (x) is unchanged by releasing focus", afterClear.x === beforeClear.x, `${afterClear.x} vs ${beforeClear.x}`);
  check("camera position (y) is unchanged by releasing focus", afterClear.y === beforeClear.y, `${afterClear.y} vs ${beforeClear.y}`);

  console.log("\n--- the viewable window shifts left to avoid the open detail panel ---");
  // Isolates panelReserve()'s effect cleanly: fitAll() (triggered here via
  // the platforms-filter toggle's own off-path, the one already-exposed way
  // to force a fresh fitAll without changing focus/extent) is run twice over
  // the exact same node extent -- once with the panel closed, once forced
  // open -- so any difference in the resulting transform is attributable
  // ONLY to the panel reserve, not to real data's off-center layout (the
  // full real dataset's extent isn't centered on x=0, so comparing against a
  // literal "x == W/2" expectation would be data-dependent and flaky).
  check("detail panel is closed right after releasing focus", document.getElementById("detail").hidden === true);
  cw.setPlatformsOnly(true); cw.setPlatformsOnly(false); // off-path calls fitAll(true)
  await wait(ANIM_WAIT);
  const closedFitT = cw.graphTransform();
  document.getElementById("detail").hidden = false; // force the panel "open" without touching focus/extent
  cw.setPlatformsOnly(true); cw.setPlatformsOnly(false);
  await wait(ANIM_WAIT);
  const openFitT = cw.graphTransform();
  document.getElementById("detail").hidden = true;
  check("fitAll's camera center shifts LEFT once the detail panel is open, for the identical fit target",
    openFitT.x < closedFitT.x, `${openFitT.x} vs ${closedFitT.x}`);

  cw.goto(G2_ID); // focusing a car opens the detail panel for real
  check("detail panel is open after a real focus navigation", document.getElementById("detail").hidden === false);

  console.log("\n--- zoom slider (bottom-left corner, horizontal) ---");
  const zs = document.getElementById("zoomslider");
  check("zoom slider element exists", !!zs);
  const kBefore = cw.graphTransform().k;
  zs.value = "100"; // max end of the slider -- should zoom all the way in
  zs.dispatchEvent(new window.Event("input"));
  const kAfterMax = cw.graphTransform().k;
  check("dragging the slider to its max end zooms in (k increased)", kAfterMax > kBefore, `${kAfterMax} vs ${kBefore}`);
  check("slider-driven zoom applies immediately, no animation wait needed", Math.abs(kAfterMax - 9) < 0.01, kAfterMax);
  const inBtn = document.getElementById("zoomslider-in"), outBtn = document.getElementById("zoomslider-out");
  check("+/- zoom buttons exist too", !!inBtn && !!outBtn);
  zs.value = "0"; zs.dispatchEvent(new window.Event("input"));
  check("dragging back to the min end zooms all the way out", Math.abs(cw.graphTransform().k - 0.22) < 0.01, cw.graphTransform().k);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
