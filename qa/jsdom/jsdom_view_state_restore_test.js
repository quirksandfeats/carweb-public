// Real user request: "if the user scans a specific car and it gets updated
// with a push, can the webpage refresh and then resume in the exact same focus
// as it was before the page refresh, to essentially show the newly changed
// graph?"
//
// What is restored is the FOCUS, not a pixel-exact camera: goto() re-frames
// the same car with the rules the app already uses, which is what "the same
// place" means to someone looking at it, and it stays right even though the
// layout underneath has genuinely changed -- which it has, since that is the
// whole reason for the reload.
//
// Two boots share one sessionStorage here, which is exactly the real shape.
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

// One store shared across both boots, like a real tab reloading.
const store = {};
const fakeSession = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

const FAM = "fam-testview";
function seed(DATA) {
  DATA.nodes.push({ id: "mk-testview", type: "make", label: "TestView", year: 1960 });
  DATA.nodes.push({ id: FAM, type: "family", label: "Restorable", make: "TestView",
    year: 1990, end: null, designers: [], engineers: [], generations: ["m-tv-g1", "m-tv-g2"] });
  ["m-tv-g1", "m-tv-g2"].forEach((id, i) => DATA.nodes.push({ id, type: "model", label: "Gen" + (i + 1),
    make: "TestView", year: 1990 + i * 10, end: 1999 + i * 10, familyOf: FAM, designers: [], engineers: [] }));
  DATA.links.push({ source: FAM, target: "mk-testview", type: "made" },
                  { source: FAM, target: "m-tv-g1", type: "generation" },
                  { source: FAM, target: "m-tv-g2", type: "generation" });
}

function boot() {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  Object.defineProperty(window, "sessionStorage", { value: fakeSession, configurable: true });
  window.fetch = () => Promise.resolve({ ok: true, headers: { get: () => '"same-etag"' }, json: async () => ({ ok: true }) });
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
  window.CarWeb.boot();
  return window;
}

// ---- first visit: the user arranges the view, then the page reloads -------
{
  const w = boot();
  const cw = w.CarWeb;
  cw.setLayer("engineers");
  cw.setYearRange(1970, 2010);
  cw.expandFamily(FAM);
  cw.goto(FAM);   // goto takes an id, not a node
  cw.openDetail(cw.byId.get("m-tv-g2"));
  w.dispatchEvent(new w.Event("beforeunload"));

  const saved = JSON.parse(store["carweb_view_state_v1"] || "null");
  t("leaving the page records where the user was", !!saved, JSON.stringify(saved));
  t("...the people layer", saved.layer === "engineers", saved.layer);
  t("...the year range", String(saved.year) === "1970,2010", String(saved.year));
  t("...which nameplates were open", (saved.expanded || []).includes(FAM), JSON.stringify(saved.expanded));
  t("...what was focused", saved.focus === FAM, saved.focus);
  t("...and which card was up", saved.detail === "m-tv-g2", saved.detail);
}

// ---- second visit: the same place, on the new data -----------------------
{
  const w = boot();
  const cw = w.CarWeb;
  t("the layer comes back", cw.layer() === "engineers", cw.layer());
  const yr = cw.yearRange();
  t("the year range comes back", yr.lo === 1970 && yr.hi === 2010, yr.lo + "-" + yr.hi);
  t("the nameplate is open again", cw.isFamilyExpanded(FAM) === true);
  t("the focus is back on the same car",
    !!cw.graphFocusSet() && cw.graphFocusSet().has(FAM), [...(cw.graphFocusSet() || [])].join(","));
  t("and the same card is up", w.document.getElementById("detail").hidden === false);

  t("the saved position is consumed, so a later manual reload starts fresh",
    store["carweb_view_state_v1"] === undefined, JSON.stringify(store));
}

// ---- stale state is ignored rather than teleporting someone ---------------
{
  store["carweb_view_state_v1"] = JSON.stringify({
    at: Date.now() - 60 * 60 * 1000, layer: "engineers", expanded: [FAM], focus: FAM,
  });
  const w = boot();
  t("a position from an hour ago is not restored", w.CarWeb.layer() !== "engineers", w.CarWeb.layer());
}

// ---- a car that no longer exists is skipped, not thrown on ----------------
{
  store["carweb_view_state_v1"] = JSON.stringify({
    at: Date.now(), layer: "designers", expanded: ["fam-that-was-merged-away"],
    focus: "m-deleted-by-the-scan", detail: "m-also-gone",
  });
  let threw = null;
  try { boot(); } catch (e) { threw = e; }
  t("a scan that merged or renamed things does not break the restore", threw === null, String(threw));
}

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
