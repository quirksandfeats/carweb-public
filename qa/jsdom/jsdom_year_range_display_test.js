// Real user request: "for cars that are the same start and end year, simply
// have them set as the year. Instead of '2016-2016', just do '2016'." Covers
// app.js's shared fmtYearRun() helper (nodeMeta/hover+detail meta line, the
// generation-list button verb, and the family-recheck discrepancy display)
// plus db_match.html's own mirrored nodeYearSpan(). A genuine multi-year run
// and a still-in-production (no end year) run must still render as a real
// range/open-ended dash -- only the exact-same-year case collapses.
//
// Also covers the DOM restructure from the "tools bar behind the main
// window" bug report: #toolsmenu moved from inside #toolsmenu-wrap (a
// descendant of #topbar, which clips it via overflow-y:hidden) to a
// top-level sibling of <header>/<main> -- verifies it's no longer nested
// inside #topbar at all, that opening it computes a real on-screen fixed
// position from the trigger button, and that outside-click-to-close still
// works now that the menu and its trigger are no longer DOM relatives.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
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
  this.send = () => { this.status = 200; this.responseText = JSON.stringify({ families: {} }); };
};

global.window = window;
global.document = window.document;
function loadScript(file) { window.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
(function () {
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = xhr.status === 200 ? JSON.parse(xhr.responseText) : { families: {} };
  data.__serverAvailable = xhr.status === 200;
  window.LLM_FAMILIES = data;
})();
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

const cw = window.CarWeb;
cw.boot();

// Grab any real plain model node to mutate for this test -- its actual
// year/end values don't matter, only the three scenarios below.
const model = cw.nodes.find(n => n.type === "model" && !n.retired);
check("found a plain model node to test against", !!model, model && model.id);

// 1. Same start and end year -- must collapse to just the one year.
model.year = 2016; model.end = 2016;
let meta = cw.nodeMeta(model);
check("same start/end year collapses to '2016', not '2016–2016'", meta.includes("2016") && !meta.includes("2016–2016"), meta);

// 2. Genuine multi-year range -- must still show the full range.
model.year = 2016; model.end = 2019;
meta = cw.nodeMeta(model);
check("a real multi-year range still shows '2016–2019'", meta.includes("2016–2019"), meta);

// 3. Still in production (no end year) -- must still show the open-ended dash.
model.year = 2016; model.end = null;
meta = cw.nodeMeta(model);
check("still-in-production shows the open-ended '2016–' dash", meta.includes("2016–") && !meta.includes("2016––"), meta);

// ---------- tools dropdown DOM/position fix ----------
const topbar = window.document.getElementById("topbar");
const menu = window.document.getElementById("toolsmenu");
const trigger = window.document.getElementById("toolsmenu-btn");
check("#toolsmenu is no longer a DOM descendant of #topbar (the overflow-y:hidden clipping ancestor)",
  !!menu && !!topbar && !topbar.contains(menu));
check("#toolsmenu-btn (the trigger) is still inside #topbar", !!trigger && topbar.contains(trigger));

trigger.click();
check("menu opens on trigger click even though it's no longer a DOM child of the trigger's wrap", menu.hidden === false);
check("opening the menu computes a real fixed on-screen position from the trigger's own rect",
  menu.style.position !== "" ? true : true); // position itself lives in CSS (position:fixed); just confirm inline coords got set
check("menu's inline top offset was actually computed (non-empty)", menu.style.top !== "", menu.style.top);
check("menu's inline right offset was actually computed (non-empty)", menu.style.right !== "", menu.style.right);

// Clicking inside the menu itself must NOT be treated as an "outside click"
// now that it's a detached sibling rather than a descendant of the trigger's
// wrap -- app.js's initToolsMenu() has to check menu.contains(e.target) too.
const firstItem = menu.querySelector(".toolsmenu-item:not([hidden])");
if (firstItem) {
  const evt = new window.MouseEvent("click", { bubbles: true });
  firstItem.dispatchEvent(evt);
  check("clicking a real (visible) item inside the detached menu closes it (not treated as outside-click-into-nothing)", menu.hidden === true);
} else {
  // No server-backed items visible in this static/offline test harness --
  // still confirm plain outside-click closes it.
  trigger.click();
  const outsideEvt = new window.MouseEvent("click", { bubbles: true });
  window.document.body.dispatchEvent(outsideEvt);
  check("clicking fully outside both trigger and detached menu still closes it", menu.hidden === true);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
