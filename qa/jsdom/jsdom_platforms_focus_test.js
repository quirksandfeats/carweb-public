// Real user request (superseding this file's original purpose, which was
// click-to-focus inside the now-removed standalone Platforms tab): "take
// all of this from the Platforms tab and apply it back to the main Graph
// tab... add a toggle which enables a 'only shared platform/relations'
// option... so that now I can also use the rest of the features like the
// search as well." Graph already HAS a generic click-to-focus mechanism
// (focusOn/neighborhoodForFocus/flyToSet) that reveals a clicked node's
// neighbors and fits the camera to them -- merging the platforms filter in
// means that mechanism, unmodified, now reproduces the old Platforms tab's
// "reveal shared platforms" behavior for free, as long as the focus
// neighborhood traversal respects the same platform/related/made/designed/
// engineered type whitelist the filter itself uses (so a car doesn't
// suddenly reveal a succession neighbor that the filter would never have
// drawn a line for). This exercises exactly that interaction, plus the
// camera-fit-on-toggle behavior.
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
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMk-focus");
if (!makeNode) { makeNode = { id: "mk-test-focus", type: "make", label: "TestMk-focus", year: 1950 }; DATA.nodes.push(makeNode); }

// A<->B platform, and separately B<->C succession (B is NOT platform-linked
// to C at all) -- while the platforms filter is on, focusing A should reveal
// B (direct platform partner) and the make hub, but never C, even though C
// individually might otherwise be reachable through B in an ordinary
// (filter-off) focus expansion.
const A_ID = "m-test-focus-a", B_ID = "m-test-focus-b", C_ID = "m-test-focus-c";
const carA = { id: A_ID, type: "model", label: "Alpha", make: "TestMk-focus", year: 2010, end: null };
const carB = { id: B_ID, type: "model", label: "Beta", make: "TestMk-focus", year: 2010, end: null };
const carC = { id: C_ID, type: "model", label: "Beta II", make: "TestMk-focus", year: 2018, end: null };
DATA.nodes.push(carA, carB, carC);
DATA.links.push({ source: A_ID, target: makeNode.id, type: "made" }, { source: B_ID, target: makeNode.id, type: "made" }, { source: C_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: A_ID, target: B_ID, type: "platform" });
DATA.links.push({ source: B_ID, target: C_ID, type: "succession" }); // B's successor, NOT a platform/related fact

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

console.log("\n--- toggling the filter fits the camera to just the filtered subset ---");
cw.setPlatformsOnly(true);
check("A and B (platform pair) are in the filtered set", cw.graphPlatformsNodeIds().has(A_ID) && cw.graphPlatformsNodeIds().has(B_ID));
check("C (only reachable via succession, not platform/related) is excluded from the filtered set", !cw.graphPlatformsNodeIds().has(C_ID));

console.log("\n--- Graph's existing click-to-focus reveals only the platform-qualifying neighborhood while the filter is on ---");
cw.goto(A_ID); // same path a real click on A's dot goes through (focusOn)
let focusSet = cw.graphFocusSet();
check("focusing A includes A itself", focusSet.has(A_ID));
check("focusing A includes its direct platform partner B", focusSet.has(B_ID));
check("focusing A includes the make hub", focusSet.has(makeNode.id));
check("focusing A does NOT reach C through B's succession link -- that link type never drew under the filter", !focusSet.has(C_ID));
check("the filter itself is still on after a normal focus navigation (A qualifies, so nothing had to override it)", cw.platformsOnly() === true);

console.log("\n--- navigating to something the filter would hide turns the filter off instead of showing nothing ---");
cw.goto(C_ID);
check("filter turned off since C doesn't qualify", cw.platformsOnly() === false);
focusSet = cw.graphFocusSet();
check("once the filter is off, focusing C can reach B (its succession predecessor) normally", focusSet.has(B_ID));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
