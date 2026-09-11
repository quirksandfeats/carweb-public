// Headless verification of the live-apply-on-confirm logic (no real browser
// available in this sandbox: missing libXdamage1, no root to install it).
// Uses jsdom + a stubbed Canvas 2D context so we can load the REAL app.js /
// llm_families.js / timeline.js unmodified and drive the actual click-Yes
// codepath, asserting on the real in-memory graph state afterward.
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

// Seed a provisional LLM proposal for a real plain model node (Dacia Logan)
// and simulate serve.py being reachable (serverAvailable: true), so the
// full interactive Yes/No/Retry UI renders and the click-Yes handler runs
// the real live-apply path instead of the read-only static fallback.
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
          { code: "Phase 1", yearStart: 2004, yearEnd: 2012, designers: [], engineers: [] },
          { code: "Phase 2", yearStart: 2012, yearEnd: 2020, designers: [], engineers: [] },
          { code: "Phase 3", yearStart: 2020, yearEnd: null, designers: [], engineers: [] },
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
// mirror index.html's inline bootstrap script exactly
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
check("serverAvailable true (seeded live mode)", window.LlmFamilies.serverAvailable === true);

const before = window.CarWeb.byId.get(TEST_ID);
check("Dacia Logan starts as a plain model", before.type === "model", before.type);
const nodesBefore = window.CarWeb.nodes.length, linksBefore = window.CarWeb.links.length;

// Open the detail panel -- this is what a real click/search selection does,
// and it's what triggers renderLlmCheck() to run. Real user request: a
// first-time nameplate creation needs no manual approval -- renderLlmCheck's
// "provisional" branch now confirms and live-applies the split immediately,
// synchronously, right here in openDetail() itself, instead of drawing a
// Yes/No/Retry review box and waiting for a click.
window.CarWeb.openDetail(before);
check("no Yes/No/Retry review box is ever shown", !window.document.querySelector(".llm-yes"));

const after = window.CarWeb.byId.get(TEST_ID);
check("node mutated in place, same object", after === before);
check("node became a family", after.type === "family", after.type);
check("family has 3 generations", after.generations && after.generations.length === 3, JSON.stringify(after.generations));
check("nodes array grew by exactly 3", window.CarWeb.nodes.length === nodesBefore + 3, window.CarWeb.nodes.length - nodesBefore);
// 3 structural family->generation "generation" links + 2 "gensucc" chain
// links between the 3 consecutive generations (gen1->gen2, gen2->gen3) = 5.
//
// This used to assert the TOTAL link growth was exactly 5. It isn't any
// more, and shouldn't be: confirming a split now also pushes this car's
// nameplate-level succession links down onto the specific generations they
// really describe (llm_families.js's pushSuccessionToGenerations -- real
// user request: "The 'Succeeds' and 'Succeeded by' information and the edge
// links should also be transferred to the generations of a nameplate").
// The Logan is a good stress case for that: it succeeds four different cars
// and is succeeded by two, so six derived generation-level succession links
// appear alongside the five structural ones. Asserted by TYPE below instead
// of as one total, so this stays a precise check on the split itself rather
// than a number that has to be re-derived every time some unrelated
// rollup legitimately adds a link.
const addedLinks = window.CarWeb.links.slice(linksBefore);
const addedByType = t => addedLinks.filter(l => l.type === t && !l.genLevel).length;
check("exactly 3 structural family->generation links added", addedByType("generation") === 3, addedByType("generation"));
check("exactly 2 gensucc chain links added", addedByType("gensucc") === 2, addedByType("gensucc"));
check("every other added link is a derived generation-level succession (nothing unexpected)",
  addedLinks.every(l => l.genLevel || l.type === "generation" || l.type === "gensucc"),
  JSON.stringify(addedLinks.filter(l => !l.genLevel && l.type !== "generation" && l.type !== "gensucc").map(l => l.type)));

const gen0 = window.CarWeb.byId.get(after.generations[0]);
const gen1 = window.CarWeb.byId.get(after.generations[1]);
const gen2 = window.CarWeb.byId.get(after.generations[2]);
check("minted generation node is indexed in byId", !!gen0);
check("minted generation has correct familyOf back-pointer", gen0.familyOf === TEST_ID, gen0.familyOf);
check("minted generation is in adj map", window.CarWeb.adj.has(gen0.id));
check("minted generation has a radius set (r)", typeof gen0.r === "number" && gen0.r > 0, gen0.r);
check("minted generation has a position (from expandFamily's line-up)", typeof gen0.x === "number" && typeof gen0.y === "number", `${gen0.x},${gen0.y}`);
check("family is expanded (generations visible immediately, no extra click)", window.CarWeb.isFamilyExpanded(TEST_ID));
check("nodeInLayer() now shows the generation (not hidden)", window.CarWeb.nodeInLayer(gen0));

// ---- gensucc chain links: gen1->gen2->gen3, in chronological order ----
// (data.js now bakes in ~240 gensucc links from build-time families too, so
// scope this to links touching THIS car's own generations, not a global
// count -- and compare via .sn/.tn, the node refs app.js resolves itself,
// since d3-force's forceLink mutates .source/.target from id strings into
// node object refs once buildSim() ticks the simulation)
const genSet = new Set([gen0, gen1, gen2]);
const gensuccLinks = window.CarWeb.links.filter(l => l.type === "gensucc" && genSet.has(l.sn) && genSet.has(l.tn));
check("exactly 2 gensucc links were minted for this family", gensuccLinks.length === 2, gensuccLinks.length);
const chain01 = gensuccLinks.find(l => l.sn === gen0 && l.tn === gen1);
const chain12 = gensuccLinks.find(l => l.sn === gen1 && l.tn === gen2);
check("gensucc chains Phase 1 -> Phase 2", !!chain01);
check("gensucc chains Phase 2 -> Phase 3", !!chain12);
check("no gensucc link skips a generation (Phase 1 -> Phase 3 directly)",
  !gensuccLinks.find(l => l.sn === gen0 && l.tn === gen2));

const entry = window.LlmFamilies.entryFor(TEST_ID);
check("LlmFamilies entry status is now confirmed", entry && entry.status === "confirmed", entry && entry.status);

// ---- detail panel: stayed open, on the SAME node, now showing generations ----
check("detail panel dt-title still shows this car (no reload/reset)",
  window.document.querySelector(".dt-title").textContent.includes("Logan"),
  window.document.querySelector(".dt-title").textContent);
const genEls = window.document.querySelectorAll(".dt-generations .dt-gen");
check("detail panel's Generations list now shows all 3", genEls.length === 3, genEls.length);
// .dt-llmcheck itself is no longer expected to go fully empty here -- a
// manual "🔄 LLM Re-check" trigger (task #120) now always renders for any
// eligible family, regardless of what else is/isn't showing (see app.js's
// renderManualRecheckButton). What actually matters for this assertion is
// that nothing from the old Yes/No/Retry review box is left behind.
const llmBlockAfter = window.document.querySelector(".dt-llmcheck").innerHTML.trim();
check("provisional Yes/No/Retry UI is gone (nothing left to decide)",
  !/llm-yes|llm-no|llm-retry-row|llm-reason/.test(llmBlockAfter), JSON.stringify(llmBlockAfter));
check("...but the manual re-check trigger is still there", /llm-recheck-btn/.test(llmBlockAfter), JSON.stringify(llmBlockAfter));

// ---- Timeline's follow-picker should include the new nameplate too ----
const opt = [...window.document.querySelectorAll("#tl-designer option")].find(o => o.textContent.includes("Logan"));
check("new nameplate appears in Timeline's Follow… picker without a reload", !!opt, opt && opt.textContent);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
