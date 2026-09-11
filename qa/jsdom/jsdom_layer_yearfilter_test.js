// Verifies the fix for: switching the people-layer toggle (Designers /
// Engineers / Both) didn't recompute the year-range filter, so an
// engineer-only person (e.g. Andreas Preuninger) stayed invisible after
// switching to the Engineers layer until something else (nudging the
// slider) happened to force a recompute.
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

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

window.CarWeb.boot();
const cw = window.CarWeb;

const p = [...cw.byId.values()].find(n => n.label === "Andreas Preuninger");
check("Andreas Preuninger exists as a real curated engineer node (test precondition)",
  !!p && p.roles.includes("engineer") && !p.roles.includes("designer"));

check("default layer (designers) correctly hides an engineer-only person", !cw.nodeInLayer(p));

cw.setLayer("engineers");
check("switching to the Engineers layer makes him nodeInLayer-visible", cw.nodeInLayer(p));
check("...AND the year filter picks him up in the SAME call, no extra slider nudge needed",
  cw.passesYearFilter(p));

cw.setLayer("designers");
check("switching back to Designers hides him again (nodeInLayer)", !cw.nodeInLayer(p));

cw.setLayer("both");
check("Both layer shows him (nodeInLayer)", cw.nodeInLayer(p));
check("...and the year filter agrees immediately", cw.passesYearFilter(p));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
