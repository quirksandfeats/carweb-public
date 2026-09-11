// Verifies task #60: clicking a nameplate (family) should reveal not just
// its generations, but also any cross-nameplate related/succession/platform
// connection that lives directly on one of those generations -- e.g. BMW X1
// (F48) is directly related to the Zinoro 60H rebadge (a real harvested
// "related" link sitting on the F48 generation node itself, not on the X1
// family node), so clicking "X1" should highlight that connection too, not
// leave it at near-zero opacity as unfocused background noise.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
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
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window;
global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
window.LLM_FAMILIES = { families: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
  loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max); // widen so nothing here gets excluded by the slider itself

const x1 = cw.byId.get("fam-bmw-x1");
const f48 = cw.byId.get("m-bmw-x1-f48");
const zinoro = cw.byId.get("m-zinoro-zinoro-60h");
check("BMW X1 family node exists (test precondition)", !!x1 && x1.type === "family");
check("X1 (F48) generation exists and belongs to the family (test precondition)", !!f48 && f48.familyOf === x1.id);
check("Zinoro 60H exists as a standalone model (test precondition)", !!zinoro && zinoro.type === "model");
const relatedLink = cw.links.find(l => l.type === "related" && l.sn === f48 && l.tn === zinoro);
check("the real harvested related-link sits on F48 itself, not on the family (test precondition)", !!relatedLink);

check("X1 family not expanded by default", !cw.isFamilyExpanded(x1.id));

cw.goto(x1.id); // same public entry point the UI's search/click ultimately drives
check("clicking X1 expanded the family", cw.isFamilyExpanded(x1.id));
check("F48 generation is now visible", cw.nodeInLayer(f48));

const focusSet = cw.graphFocusSet();
check("focus set exists after clicking the nameplate", !!focusSet);
check("F48 generation is in the focus set", focusSet.has(f48.id));
check("Zinoro 60H (two hops away: X1 -family-> F48 -related-> Zinoro) IS in the focus set -- " +
  "the whole point of task #60, so the related link renders at full opacity, not near-invisible background",
  focusSet.has(zinoro.id));

// ---------- collapsing the family back should drop the second-hop reach ----------
window.document.getElementById("clearfocus").onclick();
check("focus cleared", !cw.graphFocusSet());
check("family auto-collapsed again on clearFocus (existing behavior)", !cw.isFamilyExpanded(x1.id));

// ---------- the reverse direction: focusing Zinoro 60H reveals the F48 it's related to ----------
// This assertion used to be the exact opposite ("correctly excludes the
// hidden F48 generation"), on the reasoning that expanding a family is what
// makes its generations reachable and a plain model's own one-hop
// neighborhood shouldn't do that for you. That was overturned by a direct
// user report: "some cars that state they are related for a particular model
// do not show up in the knowledge graph as being connected, until I click to
// reveal them. I want all of the cars that are related to immediately be
// revealed as well when I click on a particular model (or make)."
//
// From the Zinoro's own detail panel the related car is listed plainly as
// "BMW X1 (F48)" -- so having the graph draw nothing for it until a second,
// separate click on the X1 nameplate reads as a missing connection, not as a
// deliberate progressive disclosure. app.js's revealRelatedFor (called from
// focusOn) now expands the far family for exactly the endpoints a
// platform/related/succession link points at, so the connection appears at
// the same moment as everything else on that click. Note this is still
// narrowly scoped: only families on the far end of a RELATION link are
// expanded, never every family in the neighborhood.
cw.goto(zinoro.id);
const zinoroFocus = cw.graphFocusSet();
check("focusing Zinoro auto-expands the X1 nameplate so the related F48 generation is revealed",
  cw.isFamilyExpanded(x1.id));
check("F48 is visible (nodeInLayer) after focusing the car it's related to", cw.nodeInLayer(f48));
check("F48 is in Zinoro's focus set -- the related connection draws immediately, no second click",
  zinoroFocus && zinoroFocus.has(f48.id));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
