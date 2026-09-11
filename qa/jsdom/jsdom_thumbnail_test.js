// Verifies task #35: per-generation thumbnails flow end-to-end through the
// real confirm path -- provisional review shows a thumbnail per generation,
// and after confirming, the now-family's minted generation nodes each carry
// their own wikiFile and render their own image in the detail panel/hover
// card instead of sharing the parent article's single thumbnail.
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
      status: "provisional",
      checkedAt: new Date().toISOString(),
      sourceTitle: "Dacia Logan",
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "Phase 1", yearStart: 2004, yearEnd: 2012, designers: [], engineers: [], wikiFile: "Dacia Logan Phase 1.jpg" },
          { code: "Phase 2", yearStart: 2012, yearEnd: 2020, designers: [], engineers: [], wikiFile: "Dacia Logan Phase 2.jpg" },
          { code: "Phase 3", yearStart: 2020, yearEnd: null, designers: [], engineers: [], wikiFile: null },
        ],
      },
      attempts: 1,
      feedback: [],
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
  loadScript("platforms.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

window.CarWeb.boot();
const before = window.CarWeb.byId.get(TEST_ID);
// Real user request: a first-time nameplate creation needs no manual
// approval -- opening the detail panel auto-confirms and live-applies this
// seeded "provisional" entry immediately, so there's no separate "review the
// proposal, see its thumbnails, then confirm" moment anymore -- per-
// generation thumbnails are only checked post-apply below, in each minted
// generation's own detail panel.
window.CarWeb.openDetail(before);

const after = window.CarWeb.byId.get(TEST_ID);
const gen1 = window.CarWeb.byId.get(after.generations[0]);
const gen3 = window.CarWeb.byId.get(after.generations[2]);
check("minted generation carries its own wikiFile", gen1.wikiFile === "Dacia Logan Phase 1.jpg", gen1.wikiFile);
check("generation with no nearby file found gets null (falls back to article thumbnail)", gen3.wikiFile === null, gen3.wikiFile);

// Open the detail panel on the specific generation (not the family) and
// confirm its OWN photo renders, distinct per generation.
window.CarWeb.openDetail(gen1);
const img1 = window.document.querySelector(".dt-imgwrap").style.backgroundImage;
check("generation 1's detail panel shows ITS OWN wiki photo immediately (no shared parent thumbnail)",
  img1.includes("Dacia_Logan_Phase_1.jpg"), img1);

window.CarWeb.openDetail(gen1 === (window.CarWeb.byId.get(after.generations[1])) ? gen1 : window.CarWeb.byId.get(after.generations[1]));
const gen2 = window.CarWeb.byId.get(after.generations[1]);
window.CarWeb.openDetail(gen2);
const img2 = window.document.querySelector(".dt-imgwrap").style.backgroundImage;
check("generation 2 shows a DIFFERENT photo than generation 1 (per-generation, not shared)",
  img2.includes("Dacia_Logan_Phase_2.jpg") && img2 !== img1, img2);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
