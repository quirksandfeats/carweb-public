// Verifies the new "none" verdict UI (task #34): debug disclosure + retry,
// instead of the old dead end.
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

const TEST_ID = "m-dacia-logan";
const seeded = {
  families: {
    [TEST_ID]: {
      status: "none",
      checkedAt: new Date().toISOString(),
      sourceTitle: "Dacia Logan",
      proposal: { hasMultipleGenerations: false, generations: [] },
      attempts: 1,
      feedback: [],
      debug: {
        raw: { hasMultipleGenerations: false, generations: [] },
        dropped: [{ code: "Phase 9", yearStart: 2099 }],
      },
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

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

window.CarWeb.boot();
const n = window.CarWeb.byId.get(TEST_ID);
window.CarWeb.openDetail(n);

const status = window.document.querySelector(".dt-llmcheck .llm-status");
check("shows the 'no multiple generations' verdict", !!status && status.textContent.includes("no multiple generations"), status && status.textContent);
const debugBtn = window.document.querySelector(".llm-debug-toggle");
check("'see what it said' debug toggle is present (debug data exists)", !!debugBtn);
const debugBox = window.document.querySelector(".llm-debug");
check("debug box starts hidden", debugBox && debugBox.hidden === true);
if (debugBtn) debugBtn.onclick();
check("debug box reveals raw + dropped output on click", debugBox && debugBox.hidden === false && debugBox.innerHTML.includes("Phase 9"), debugBox && debugBox.innerHTML);

const retryBtn = window.document.querySelector(".llm-retry");
const reasonInput = window.document.querySelector(".llm-reason");
check("retry-with-feedback is offered (no longer a dead end)", !!retryBtn && !!reasonInput);

reasonInput.value = "check the History section, it mentions a second and third generation";
retryBtn.onclick();
check("clicking retry immediately shows a 'trying again' status", window.document.querySelector(".dt-llmcheck").textContent.includes("trying again"));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
