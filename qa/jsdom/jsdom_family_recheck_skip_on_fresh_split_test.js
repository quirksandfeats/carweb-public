// Real bug report: confirming a plain model's multi-generation split (e.g.
// Mercedes-Benz G-Class -> W460/W461/W463) auto-applies it into a real
// family, but with 🤖 LLM Check toggled on, the VERY NEXT render used to
// immediately kick off a SECOND, completely independent check --
// llm_families.js's checkFamily (the nameplate generation-list cross-check,
// isEligibleForRecheck/renderLlmCheckFamily) -- re-fetching the same
// Wikipedia article and re-asking the local LLM to re-derive the exact
// generation list it had just derived seconds earlier, purely to compare it
// against itself. jsdom_llm_confirm_test.js never caught this because it
// never turns llmCheckOn on, so renderLlmCheckFamily's "no entry yet" branch
// silently no-ops there regardless of whether the redundant check would fire.
// The fix: applyConfirmed seeds store.recheck[nodeId] with a "none" (no
// discrepancy) entry the moment it converts a confirmed model into a family,
// since that entry's own proposal IS the freshly-extracted list -- comparing
// it against itself can only ever be a no-op, so there's nothing left to
// check. Verifies that seed lands, AND that no second Wikipedia/llama.cpp
// network round-trip ever happens.
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

// Instrumented fetch: records every URL asked for, so a wikipedia.org or
// /api/llm/chat call (the two things a REAL checkFamily run would make)
// is directly observable rather than inferred from UI text alone.
const fetchCalls = [];
window.fetch = (url) => {
  fetchCalls.push(String(url));
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};

const TEST_ID = "m-test-gclass";
const seeded = {
  families: {
    [TEST_ID]: {
      status: "provisional",
      checkedAt: new Date().toISOString(),
      sourceTitle: "TestBrand G-Class",
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
// Seed a plain model node for this synthetic nameplate, same shape a real
// build-time car would have (has its own wp so checkFamily COULD run if the
// bug were still present).
(function seedPlainModel() {
  const DATA = window.CARDATA;
  let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestBrand");
  if (!makeNode) { makeNode = { id: "mk-testbrand", type: "make", label: "TestBrand", year: 1979 }; DATA.nodes.push(makeNode); }
  const model = { id: TEST_ID, type: "model", label: "G-Class", make: "TestBrand", year: 1979, end: null,
    wp: "TestBrand G-Class", designers: [], engineers: [] };
  DATA.nodes.push(model);
  DATA.links.push({ source: TEST_ID, target: makeNode.id, type: "made" });
})();
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
loadScript("platforms.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

window.CarWeb.boot();
window.CarWeb.setLlmCheck(true); // real bug report happened with LLM Check ON

const before = window.CarWeb.byId.get(TEST_ID);
check("precondition: starts as a plain model", before.type === "model", before.type);

// Opening the detail panel triggers renderLlmCheck -> sees the seeded
// provisional proposal -> auto-applies (first-time nameplate creation needs
// no approval) -> converts to a family -> re-renders the panel in place.
window.CarWeb.openDetail(before);

const after = window.CarWeb.byId.get(TEST_ID);
check("node became a family", after.type === "family", after.type);
check("family has all 3 generations", after.generations && after.generations.length === 3, after.generations);

const recheckEntry = window.LlmFamilies.recheckEntryFor(TEST_ID);
check("recheck entry was seeded immediately (not missing)", !!recheckEntry, recheckEntry);
check("seeded recheck entry says 'none' (no discrepancy -- nothing to check)",
  recheckEntry && recheckEntry.status === "none", recheckEntry && recheckEntry.status);
check("seeded recheck entry carries the same proposal that was just confirmed",
  recheckEntry && recheckEntry.proposal && recheckEntry.proposal.generations.length === 3,
  recheckEntry && recheckEntry.proposal);

const llmBlockHtml = window.document.querySelector(".dt-llmcheck").innerHTML;
check("no 'cross-checking...' message shown right after the split is confirmed",
  !llmBlockHtml.includes("cross-checking"), llmBlockHtml);

// NOTE: fetchCalls legitimately includes a "wikipedia.org/api/rest_v1/page/
// summary/..." call -- that's app.js's own unrelated detail-panel thumbnail
// lookup (see app.js's fetch to that exact path), not anything to do with
// the LLM cross-check. What checkFamily's fetchArticleDigest actually hits
// is the "w/api.php?action=parse" article-wikitext endpoint -- that's the
// one that must NOT appear a second time here.
const articleFetchCalls = fetchCalls.filter(u => u.includes("action=parse"));
const llmCalls = fetchCalls.filter(u => u.includes("/api/llm/chat"));
check("no second Wikipedia ARTICLE fetch happened (the redundant re-read this bug caused)",
  articleFetchCalls.length === 0, fetchCalls);
check("no second llama.cpp call happened (the redundant re-extraction this bug caused)",
  llmCalls.length === 0, fetchCalls);

// ---------- fresh reload: the seed must survive a real page reload too ----------
// applyConfirmed re-runs at boot for every already-"confirmed" store.families
// entry (the node starts back at type "model" from static data each load),
// so the seed has to be re-derived on every boot, not just the first one.
const dom2 = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const window2 = dom2.window;
window2.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window2.requestAnimationFrame = () => 1;
window2.devicePixelRatio = 1;
window2.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window2.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
const fetchCalls2 = [];
window2.fetch = (url) => { fetchCalls2.push(String(url)); return Promise.resolve({ ok: true, json: async () => ({ ok: true }) }); };
// This time seed store.families with the CONFIRMED entry (as it would be on
// disk after the real session above ran confirmNode+persist), same as a real
// reload would read back from llm_families.json.
const confirmedGens = seeded.families[TEST_ID].proposal.generations;
const seeded2 = {
  families: {
    [TEST_ID]: Object.assign({}, seeded.families[TEST_ID], {
      status: "confirmed", decidedAt: new Date().toISOString(),
      allDesigners: [], allEngineers: [],
    }),
  },
};
window2.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { this.status = 200; this.responseText = JSON.stringify(seeded2); };
};
global.window = window2; global.document = window2.document;
function loadScript2(file) { window2.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
loadScript2("d3.min.js");
loadScript2("data.js");
(function seedPlainModel2() {
  const DATA = window2.CARDATA;
  let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestBrand");
  if (!makeNode) { makeNode = { id: "mk-testbrand", type: "make", label: "TestBrand", year: 1979 }; DATA.nodes.push(makeNode); }
  const model = { id: TEST_ID, type: "model", label: "G-Class", make: "TestBrand", year: 1979, end: null,
    wp: "TestBrand G-Class", designers: [], engineers: [] };
  DATA.nodes.push(model);
  DATA.links.push({ source: TEST_ID, target: makeNode.id, type: "made" });
})();
(function () {
  const xhr = new window2.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = xhr.status === 200 ? JSON.parse(xhr.responseText) : { families: {} };
  data.__serverAvailable = xhr.status === 200;
  window2.LLM_FAMILIES = data;
})();
loadScript2("llm_families.js");
loadScript2("app.js");
loadScript2("timeline.js");
loadScript2("sixdeg.js");
loadScript2("platforms.js");

window2.CarWeb.boot(); // applyConfirmed runs here, at boot, no interaction at all
window2.CarWeb.setLlmCheck(true);
const afterReload = window2.CarWeb.byId.get(TEST_ID);
check("fresh reload: node is a family again, no clicks needed", afterReload.type === "family", afterReload.type);
const recheckEntry2 = window2.LlmFamilies.recheckEntryFor(TEST_ID);
check("fresh reload: recheck entry is re-seeded as 'none' at boot", recheckEntry2 && recheckEntry2.status === "none", recheckEntry2);

window2.CarWeb.openDetail(afterReload);
const llmBlockHtml2 = window2.document.querySelector(".dt-llmcheck").innerHTML;
check("fresh reload: opening the panel doesn't show 'cross-checking...' either",
  !llmBlockHtml2.includes("cross-checking"), llmBlockHtml2);
const articleFetchCalls2 = fetchCalls2.filter(u => u.includes("action=parse"));
check("fresh reload: no Wikipedia ARTICLE fetch happened on reopen", articleFetchCalls2.length === 0, fetchCalls2);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
