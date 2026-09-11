// Verifies task #32 (static/live parity): a plain double-clicked index.html
// (file://, XHR to /api/llm-families fails) should fall back to the
// llm_families_data.js companion mirror and still show confirmed LLM
// generation splits identically to the live session -- but the interactive
// Yes/No/Retry controls must NOT appear (read-only, no server to persist to).
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const dom = new JSDOM(html, { url: "http://localhost/index.html", runScripts: "outside-only" });
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
window.fetch = () => Promise.reject(new Error("no fetch on file://"));

// file:// -> XHR throws (jsdom's XHR against a file:// origin with no server
// behaves like a real browser blocking it); the inline bootstrap script's
// try/catch is exactly what's supposed to catch this and fall back.
window.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { throw new Error("XHR blocked on file://"); };
};

global.window = window;
global.document = window.document;

function loadScript(file) { window.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
// A controlled fixture instead of the real project's llm_families_data.js --
// that file reflects whatever the user's own live llama.cpp testing has most
// recently produced (it's a real, actively-changing file, not a fixture),
// which made this test fragile. Seed window.LLM_FAMILIES_STATIC directly
// with the exact shape serve.py would have written, matching the real
// companion-mirror mechanism being tested without depending on its content.
window.eval(`window.LLM_FAMILIES_STATIC = ${JSON.stringify({
  families: {
    "m-mercedes-benz-g-class": {
      status: "confirmed",
      checkedAt: "2026-01-01T00:00:00.000Z",
      sourceTitle: "Mercedes-Benz G-Class",
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "W460", yearStart: 1979, yearEnd: 1991, designers: [], engineers: [] },
          { code: "W461", yearStart: 1991, yearEnd: null, designers: [], engineers: [] },
          { code: "W463", yearStart: 1990, yearEnd: null, designers: [], engineers: [] },
        ],
      },
      attempts: 1,
      feedback: [],
      decidedAt: "2026-01-01T00:00:00.000Z",
    },
  },
})};`);
// mirror index.html's actual (updated) inline bootstrap script
(function () {
  try {
    const xhr = new window.XMLHttpRequest();
    xhr.open("GET", "/api/llm-families", false);
    xhr.send(null);
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      data.__serverAvailable = true;
      window.LLM_FAMILIES = data;
      return;
    }
  } catch (e) { /* expected on file:// */ }
  window.LLM_FAMILIES = Object.assign({ families: {} }, window.LLM_FAMILIES_STATIC, { __serverAvailable: false });
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

window.CarWeb.boot();
check("serverAvailable is false on file://", window.LlmFamilies.serverAvailable === false);
check("static mirror data was loaded", Object.keys(window.LLM_FAMILIES.families).length > 0, Object.keys(window.LLM_FAMILIES.families));

// The real llm_families.json has m-mercedes-benz-g-class confirmed -- it
// should show up as a real family node on the static/file:// build too.
const gclass = window.CarWeb.byId.get("m-mercedes-benz-g-class");
check("previously-confirmed G-Class is a family node even on file://", gclass.type === "family", gclass.type);
check("G-Class family has its generations", gclass.generations && gclass.generations.length > 0, gclass.generations);

// A model with a merely-provisional (undecided) entry should NOT show
// interactive Yes/No/Retry controls in read-only/static mode.
window.CarWeb.setLlmCheck(true);
const btn = window.document.getElementById("llmcheck");
check("LLM Check toggle button stays hidden (no server) even if toggled on", btn.hidden === true, btn.hidden);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
