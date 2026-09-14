// Real user request: "the UI for the mobile version is still a bit cluttered."
// Four parts, all here:
//
//  1. The title at the top left IS the menu, and the dropdown holds the view
//     tabs, the people layer, shared platforms, the year range and Request
//     scan -- in that order.
//  2. The search box moves to the top right of the header.
//  3. The legend folds away, and the camera has to know which it currently is,
//     "so that when searching for a car or selecting it, the main car being
//     focused is in the correct part of the viewable window".
//  4. No zoom slider on a phone -- "it is clear that the user can do so
//     themselves with their fingers".
//
// Plus point 5, which is not phone-specific: the year range starts at ALL
// years, on every screen size.
//
// The controls are MOVED into the menu rather than duplicated, so this also
// asserts there is still exactly one of each in the page -- two year sliders
// that could disagree would be worse than a cluttered bar.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

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

// Two loads: one that reports itself as a phone to matchMedia, one that does
// not. jsdom implements matchMedia but always answers false, so the phone run
// stubs it -- the app reads the breakpoint through matchMedia precisely so it
// can be driven, rather than measuring window.innerWidth in two places.
function boot(isPhone, legendHeight) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.matchMedia = (q) => ({
    matches: isPhone && /max-width:\s*720px/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.Element.prototype.getBoundingClientRect = function () {
    // The legend is the one element whose measured height the camera depends
    // on, so it gets a real one; everything else can be the canvas box.
    if (this.id === "legend" && !this.hidden) {
      return { width: 380, height: legendHeight || 0, top: 42, left: 8,
               right: 388, bottom: 42 + (legendHeight || 0), x: 8, y: 42 };
    }
    return { width: 400, height: 800, top: 0, left: 0, right: 400, bottom: 800, x: 0, y: 0 };
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  function load(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  load("d3.min.js"); load("data.js");
  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
  load("llm_families.js"); load("app.js"); load("timeline.js"); load("sixdeg.js");
  window.CarWeb.boot();
  return window;
}

// ---------- 1. the title is the menu ----------
{
  const w = boot(true, 90);
  const doc = w.document;
  const trigger = doc.getElementById("navmenu-btn");
  const menu = doc.getElementById("navmenu");
  check("the wordmark is a real button, so it can be tapped and announced",
        trigger && trigger.tagName === "BUTTON", trigger && trigger.tagName);
  check("the menu starts closed", menu.hidden === true);
  check("...and says so to a screen reader", trigger.getAttribute("aria-expanded") === "false");

  const ids = [...menu.children].map(el => el.id);
  check("the dropdown holds the controls, in the order asked for",
        JSON.stringify(ids) === JSON.stringify(
          ["viewtabs", "layertoggle", "platformsonly", "yearfilter", "llmrequest-wrap"]),
        JSON.stringify(ids));
  check("the year range lives in there now, not in the bar",
        doc.getElementById("yearfilter").parentElement === menu);

  // Moved, not copied.
  ["viewtabs", "layertoggle", "platformsonly", "yearfilter", "yf-lo", "yf-hi", "search"]
    .forEach(id => check(`exactly one #${id} in the page`,
      doc.querySelectorAll("#" + id).length === 1, doc.querySelectorAll("#" + id).length));

  trigger.onclick({ stopPropagation() {} });
  check("tapping the title opens it", menu.hidden === false);
  check("...and marks it open", trigger.getAttribute("aria-expanded") === "true");
  // Picking a year is something you do several of in a row, so the panel has
  // to survive a click inside itself.
  doc.getElementById("yf-lo").dispatchEvent(new w.Event("click", { bubbles: true }));
  check("a click on a control inside does NOT close it", menu.hidden === false);
  // Switching view replaces what you are looking at, so that one does.
  doc.querySelector('#navmenu .tab[data-view="timeline"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  check("switching view closes it behind itself", menu.hidden === true);

  // ---------- 2. search at the top right ----------
  check("the search box sits in the header, not the control bar",
        doc.getElementById("searchbar-fixed").parentElement === doc.getElementById("topbar"));
  check("...and last in it, so it lands on the right",
        doc.getElementById("topbar").lastElementChild === doc.getElementById("searchbar-fixed"));
  check("the body is flagged for the phone layout, so the CSS can follow",
        doc.body.classList.contains("phone-nav"));

  // ---------- 3. the legend folds, and the camera follows ----------
  const btn = doc.getElementById("legendtoggle");
  const legend = doc.getElementById("legend");
  check("the legend has a fold-away button on a phone", btn && btn.hidden === false);
  check("it starts open, so a first visit still explains the colours", legend.hidden === false);
  const openCam = w.CarWeb.graphCamera();
  check("...and the camera reserves the space it covers", openCam.reserveTop > 0, openCam.reserveTop);
  const openCentre = openCam.centerY;

  btn.onclick();
  check("tapping it folds the legend away", legend.hidden === true);
  const shutCam = w.CarWeb.graphCamera();
  check("...the camera stops reserving for it", shutCam.reserveTop === 0, shutCam.reserveTop);
  check("...so the focus point moves UP into the space that opened",
        shutCam.centerY < openCentre, shutCam.centerY + " vs " + openCentre);
  btn.onclick();
  check("and it opens again", legend.hidden === false);

  // ---------- 4. no zoom slider ----------
  const phoneCss = css.slice(css.indexOf("@media (max-width:720px)"));
  const zoom = /#zoomslider-wrap\{([^}]*)\}/.exec(phoneCss);
  check("the zoom slider is gone on a phone -- pinch already does it",
        !!zoom && /display:none/.test(zoom[1]), zoom && zoom[1].trim());
}

// ---------- the wide layout is untouched ----------
{
  const w = boot(false, 0);
  const doc = w.document;
  check("on a wide screen the tabs stay in the bar",
        doc.getElementById("viewtabs").parentElement === doc.getElementById("topbar"));
  check("...the year slider stays in the control bar",
        doc.getElementById("yearfilter").parentElement === doc.getElementById("controlbar"));
  check("...the search stays in the control bar",
        doc.getElementById("searchbar-fixed").parentElement === doc.getElementById("controlbar"));
  check("...the menu is empty and closed", doc.getElementById("navmenu").children.length === 0 &&
        doc.getElementById("navmenu").hidden === true);
  check("...there is no fold-away button", doc.getElementById("legendtoggle").hidden === true);
  check("...and the legend is shown", doc.getElementById("legend").hidden === false);
  check("...and the body is not flagged as a phone", !doc.body.classList.contains("phone-nav"));
}

// ---------- 5. all years by default, on every screen ----------
{
  [true, false].forEach(isPhone => {
    const w = boot(isPhone, 0);
    const r = w.CarWeb.yearRange();
    check(`${isPhone ? "phone" : "desktop"}: the year range opens at every year the data has`,
          r.lo === r.min && r.hi === r.max, `${r.lo}-${r.hi} of ${r.min}-${r.max}`);
    // ...and a range you set yourself survives, rather than being re-widened.
    w.CarWeb.setYearRange(1990, 2010);
    const saved = w.localStorage.getItem("cw-year-range");
    check(`${isPhone ? "phone" : "desktop"}: ...and a range you choose is remembered`,
          saved === "1990,2010", saved);
  });
  const markup = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
  check("the slider's own markup starts wide too, so the first paint matches",
        /id="yf-lo"[^>]*value="1886"/.test(markup));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
