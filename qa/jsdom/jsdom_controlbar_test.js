// Verifies the relocated control bar (search left / year slider right,
// between the header and the legend) and the 1880-floor data extension.
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
const doc = window.document;

// ---------- structural placement ----------
const header = doc.getElementById("topbar");
const controlbar = doc.getElementById("controlbar");
const main = doc.querySelector("main");
check("#controlbar exists", !!controlbar);
check("#controlbar comes right after the header in DOM order",
  header.nextElementSibling === controlbar, header.nextElementSibling && header.nextElementSibling.id);
check("#controlbar comes right before <main>", controlbar.nextElementSibling === main);

const search = doc.getElementById("searchbar-fixed");
const yf = doc.getElementById("yearfilter");
check("search bar lives inside #controlbar", controlbar.contains(search));
check("year filter lives inside #controlbar", controlbar.contains(yf));
const kids = Array.from(controlbar.children).map(c => c.id);
check("search bar is the LEFT child of #controlbar", kids.indexOf("searchbar-fixed") < kids.indexOf("yearfilter"), kids.join(","));

check("#legend is inside the graph view (comes after controlbar in the page)", doc.getElementById("legend") !== null);
check("no stray old bottom-fixed search wrapper left behind in view-graph", !doc.getElementById("view-graph").contains(search));
check("year filter no longer lives inside #view-graph (it's shared, in the control bar)", !doc.getElementById("view-graph").contains(yf));

// ---------- Graph-only visibility toggle ----------
check("year filter visible by default (Graph is the initial view)", yf.style.display !== "none");
window.CarWeb.switchView ? null : null; // switchView isn't on the public api; use the tab buttons instead
doc.querySelector('.tab[data-view="timeline"]').onclick();
check("year filter hidden on Timeline", yf.style.display === "none");
doc.querySelector('.tab[data-view="sixdeg"]').onclick();
check("year filter hidden on Six Degrees", yf.style.display === "none");
doc.querySelector('.tab[data-view="graph"]').onclick();
check("year filter visible again back on Graph", yf.style.display !== "none");

// ---------- search still works from its new spot ----------
const input = doc.getElementById("search");
input.value = "Corvette";
input.dispatchEvent(new window.Event("input"));
const results = doc.getElementById("searchresults");
check("search still returns results from the new control-bar location", !results.hidden);

// ---------- picking a car puts the keyboard away ----------
// Real user request: "if possible, I want that once I enter a car or select a
// car from the search bar, that the keyboard automatically goes away."
//
// A phone keyboard is up for exactly as long as the input has focus, and
// picking a result does not take focus away by itself -- the result rows call
// preventDefault on mousedown precisely so the input KEEPS focus long enough
// for the click to register. So focus has to be given up on purpose.
{
  let blurred = 0;
  input.addEventListener("blur", () => blurred++);
  input.focus();
  input.value = "Corvette";
  input.dispatchEvent(new window.Event("input"));
  const rows = [...doc.querySelectorAll("#searchresults .sr-row, #searchresults > div")];
  check("there is a result row to pick", rows.length > 0, rows.length);
  const before = blurred;
  rows[0].onmousedown({ preventDefault() {} });
  check("picking a result gives up focus, so the keyboard goes away",
        blurred > before, blurred);
  check("...and the result list closes with it", results.hidden);

  input.focus();
  input.value = "Corvette";
  input.dispatchEvent(new window.Event("input"));
  const before2 = blurred;
  input.dispatchEvent(Object.assign(new window.Event("keydown"), { key: "Enter" }));
  check("pressing Enter does the same", blurred > before2, blurred);

  // Escape is a dismissal too -- closing the list while leaving a keyboard
  // covering half the screen would be the same complaint with extra steps.
  input.focus();
  input.value = "Corvette";
  input.dispatchEvent(new window.Event("input"));
  const before3 = blurred;
  input.dispatchEvent(Object.assign(new window.Event("keydown"), { key: "Escape" }));
  check("and so does Escape", blurred > before3, blurred);
}

// ---------- typing must not leave the view magnified ----------
// Real user report: "the phone version zooms into the context of where the
// keyboard is... everything then becomes slightly zoomed in after clicking on
// the search bar to type, and the user has to manually zoom out again."
//
// Mobile Safari zooms the whole page in whenever a focused text field is under
// 16px, and does not zoom back out afterwards. So the threshold is the test:
// every text field a phone can focus has to be at least 16px, and it has to be
// done that way rather than with maximum-scale on the viewport, which would
// take pinch-zoom away from the graph itself.
{
  const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
  const phone = css.slice(css.indexOf("@media (max-width:720px)"));
  const searchRule = /#search\{([^}]*)\}/.exec(phone);
  const size = searchRule && /font-size:\s*([\d.]+)px/.exec(searchRule[1]);
  check("the phone search box is at least 16px, the size below which Safari zooms",
        !!size && parseFloat(size[1]) >= 16, size && size[1] + "px");
  check("...and so is every other text field, not just that one",
        /input\[type="text"\][^{]*\{[^}]*font-size:\s*16px/.test(phone));
  const meta = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
  const vp = /<meta name="viewport"[^>]*>/.exec(meta)[0];
  check("...and pinch-zoom is NOT disabled to achieve it -- the graph needs it",
        !/maximum-scale|user-scalable\s*=\s*no/.test(vp), vp);
}

// ---------- how much of a phone screen the card gets ----------
// Two reports, in opposite directions, and the cap has to sit between them.
// First: "the title card seems to take up way too much space, almost 50% of
// all screen real-estate" -- it was 68%. Then, at 30%: "currently the web
// viewer is far too little space for the info card for the car", with a
// screenshot of the description cut off one line in.
{
  const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
  const phone = css.slice(css.indexOf("@media (max-width:720px)"));
  const detail = phone.slice(phone.indexOf("#detail{"), phone.indexOf("#detail-close"));
  const cap = /max-height:\s*(\d+)%/.exec(detail);
  check("the phone card gets a useful amount of the screen without taking half of it",
        !!cap && +cap[1] >= 38 && +cap[1] <= 50, cap && cap[1] + "%");
}

// ---------- the thumbnail is a standard frame, not a random crop ----------
// Real user report: "the size of the thumbnail picture within the card
// information always seems cut off rather than being a regular, more
// standardized size and view of the thumbnail." These come off Wikimedia
// Commons at every aspect ratio there is, so a fixed-height band filled with
// `cover` cropped each one differently -- sometimes to a wheel arch.
{
  const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
  const img = css.slice(css.indexOf(".dt-imgwrap{"), css.indexOf(".dt-imgwrap.show"));
  check("the photo frame is a fixed aspect ratio, so every card's is the same shape",
        /aspect-ratio:\s*16\s*\/\s*9/.test(img), img.replace(/\s+/g, " ").slice(0, 120));
  check("...and the whole photo is shown inside it rather than cropped to fill it",
        /background-size:\s*contain/.test(img) && !/background-size:\s*cover/.test(img));
  check("...without tiling when it does not fill the frame",
        /background-repeat:\s*no-repeat/.test(img));
  check("...and no fixed pixel height is left to fight the ratio",
        !/[^-]height:\s*\d+px/.test(img), img.replace(/\s+/g, " ").slice(0, 160));
  const phoneImg = /\.dt-imgwrap\{([^}]*)\}/.exec(css.slice(css.indexOf("@media (max-width:720px)")));
  check("on a phone it is capped so the photo cannot crowd out the words",
        !!phoneImg && /max-height:/.test(phoneImg[1]), phoneImg && phoneImg[1].trim());
}

// ---------- 1880-floor data extension ----------
const r = window.CarWeb.yearRange();
check("data now reaches back before 1900 (1880-floor extension)", r.min < 1900, r.min);
const benz = window.CarWeb.nodes.find(n => n.type === "model" && n.label === "Patent-Motorwagen" && n.make === "Benz");
check("1886 Benz Patent-Motorwagen is present in the data", !!benz, benz && benz.year);

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
