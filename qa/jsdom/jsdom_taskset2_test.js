// Verifies the second batch of fixes: search-results overflow, detail panel
// vs. the year slider, gensucc chain links + their year-filter behavior on
// LLM-confirmed families (the exact overlap/omit semantics the user specified).
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

// ---------- CSS source checks (structural, no live layout engine here) ----------
check("#searchresults is re-anchored left (not spilling off the left edge)",
  /#searchresults\{\s*right:auto;\s*left:0;\s*\}/.test(css));
check("#detail's top offset is small (16px) now that it's relative to <main>, not the viewport",
  /#detail\{[^}]*top:16px/.test(css));
check("gensucc gets its own CSS color variable", /--gensucc:#[0-9a-f]+/i.test(css));
check("gensucc legend swatch is a solid line (no dashed pattern)", /\.sw-gensucc\{[^}]*border-top:[^}]*solid/.test(css));

// ---------- DOM structure ----------
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const doc = dom.window.document;
const main = doc.querySelector("main");
const detail = doc.getElementById("detail");
check("#detail now lives inside <main> (so its absolute top is relative to main, below the control bar)",
  main.contains(detail));
check("#detail is NOT a direct child of <body> anymore", detail.parentElement !== doc.body);
const legendGensucc = doc.querySelector(".sw-gensucc");
check("legend has a 'next generation' entry", !!legendGensucc);

// ---------- live app: gensucc chain + year-filter-on-confirm ----------
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
const dom2 = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const window = dom2.window;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });

const TEST_ID = "m-dacia-logan";
// Years are deliberately shaped like the user's own sanity-check example:
// gen1 entirely before the lower bound, gen2 straddling it, gen3 open-ended
// and after it.
const seeded = {
  families: {
    [TEST_ID]: {
      status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "Dacia Logan",
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "Gen 1", yearStart: 1980, yearEnd: 1985, designers: [], engineers: [] },
          { code: "Gen 2", yearStart: 1985, yearEnd: 1995, designers: [], engineers: [] },
          { code: "Gen 3", yearStart: 1995, yearEnd: null, designers: [], engineers: [] },
        ],
      },
      attempts: 1, feedback: [],
    },
  },
};
window.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { this.status = 200; this.responseText = JSON.stringify(seeded); };
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

window.CarWeb.boot();
const cw = window.CarWeb;

// real build-time data: at least one gensucc chain link should already
// exist among the confirmed nameplate families baked in at build time.
const buildTimeGensucc = cw.links.filter(l => l.type === "gensucc" && !l.sn?.llmGenerated);
check("build-time family layer already produced gensucc chain links", buildTimeGensucc.length > 0, buildTimeGensucc.length);

// narrow the slider BEFORE confirming, mimicking a user who already
// narrowed the range, then discovers/confirms a new generational split.
cw.setYearRange(1990, cw.yearRange().max);

const before = cw.byId.get(TEST_ID);
// Real user request: a first-time nameplate creation needs no manual
// approval -- opening the detail panel auto-confirms and live-applies this
// seeded "provisional" entry immediately.
cw.openDetail(before);

const after = cw.byId.get(TEST_ID);
const [g1, g2, g3] = after.generations.map(id => cw.byId.get(id));
check("3 generations minted", after.generations.length === 3, after.generations.length);

// the actual bug under test: without refreshYearFilter() in applyLlmConfirm,
// passesYearFilter would report false for ALL of these (not in the
// precomputed set at all yet), regardless of their real years.
check("gen1 (1980-1985) correctly excluded -- entirely before the 1990 lower bound",
  !cw.passesYearFilter(g1));
check("gen2 (1985-1995) correctly included -- overlaps the 1990 lower bound",
  cw.passesYearFilter(g2));
check("gen3 (1995-present) correctly included -- starts after the lower bound",
  cw.passesYearFilter(g3));

// gensucc chain for the freshly-confirmed family too
const newChain = cw.links.filter(l => l.type === "gensucc" && (l.sn === g1 || l.sn === g2));
check("gensucc chain minted for the newly-confirmed generations too", newChain.length === 2, newChain.length);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
