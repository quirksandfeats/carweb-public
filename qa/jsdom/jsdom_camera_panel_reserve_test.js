// Real user report, from a phone: "when I search for a particular car, it
// zooms into it as it's supposed to but it's not within the view of the
// available knowledge graph window. Oftentimes it is behind the info card for
// the car I searched for, out of view."
//
// The camera already reserved room for the detail panel -- an earlier request
// ("the viewable window is actually represented by the area where the info
// card isn't") -- but it reserved it on ONE fixed axis: 346px of WIDTH, for a
// card anchored to the right. Below 720px that panel is not a card at all, it
// is a bottom SHEET spanning the full width, so the reservation both narrowed
// the camera for no reason and parked the result underneath the sheet.
//
// Which axis to reserve is now decided by MEASURING the panel rather than by
// matching the breakpoint, so the CSS and the camera cannot disagree about
// where the panel is. This drives that decision directly: every path that
// moves the camera goes through a d3 transition, which a headless test cannot
// advance, so the transform is not observable here -- its two inputs are.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

// <main> is 1000x800. The two panel shapes are the real ones from styles.css:
// a 308px card 18px off the right edge, and a full-width sheet 68% tall.
const MAIN = rect(0, 0, 1000, 800);
const CARD = rect(1000 - 308 - 18, 16, 308, 700);
const SHEET = rect(0, 800 - 544, 1000, 544);

let panelShape = null;   // null = panel closed

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  if (this.id === "detail") return panelShape || rect(0, 0, 0, 0);
  return MAIN;
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const loadScript = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
loadScript("d3.min.js");
loadScript("data.js");
window.LLM_FAMILIES = { families: {}, relations: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

const cw = window.CarWeb;
cw.boot();
const dt = window.document.getElementById("detail");

// ---- panel closed: the whole canvas, on both axes -------------------------
{
  dt.hidden = true; panelShape = null;
  const c = cw.graphCamera();
  t("with no panel open nothing is reserved", c.reserveX === 0 && c.reserveY === 0, JSON.stringify(c));
  t("...and the camera centres on the canvas", c.centerX === 500 && c.centerY === 400, c.centerX + "," + c.centerY);
}

// ---- the desktop card: width reserved, height untouched -------------------
{
  dt.hidden = false; panelShape = CARD;
  const c = cw.graphCamera();
  t("a right-anchored card is not mistaken for a sheet", c.isSheet === false);
  t("...reserves width, as it always did", c.reserveX === 346, c.reserveX);
  t("...reserves no height", c.reserveY === 0, c.reserveY);
  t("...so the centre shifts left and stays vertically centred",
    c.centerX === (1000 - 346) / 2 && c.centerY === 400, c.centerX + "," + c.centerY);
}

// ---- the phone sheet: the axis flips --------------------------------------
{
  dt.hidden = false; panelShape = SHEET;
  const c = cw.graphCamera();
  t("a full-width panel is recognised as a sheet", c.isSheet === true);
  t("...reserves no width, so the camera stops being needlessly narrow", c.reserveX === 0, c.reserveX);
  t("...reserves the height it actually covers", c.reserveY === 544 + 12, c.reserveY);
  t("...and the centre moves UP, into the strip the sheet leaves visible",
    c.centerX === 500 && c.centerY === (800 - 556) / 2, c.centerX + "," + c.centerY);
  t("the focus point is above the top of the sheet",
    c.centerY < SHEET.top, c.centerY + " vs " + SHEET.top);
}

// ---- a sheet tall enough to swallow the canvas still leaves a strip -------
{
  dt.hidden = false; panelShape = rect(0, 20, 1000, 780);
  const c = cw.graphCamera();
  t("a near-full-height sheet is capped rather than collapsing the camera",
    c.reserveY === 800 * 0.72, c.reserveY);
  t("...leaving a usable centre", c.centerY > 60 && c.centerY < 800, c.centerY);
}

// ---- closing the panel restores the full canvas ---------------------------
{
  dt.hidden = true; panelShape = null;
  const c = cw.graphCamera();
  t("closing the panel gives the whole canvas back", c.reserveX === 0 && c.reserveY === 0 && c.centerY === 400);
}

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
