// New feature (not a bug fix): a "Playground" panel (#llmplaygroundbtn /
// #llmplayground) that lets a person see the EXACT prompt a real check
// would send, run it against this session's own Ollama if one is reachable
// ("Run it here"), or paste in a response typed/copied from anywhere else
// (their own local model, a different machine, ChatGPT, whatever) and
// preview -- or apply -- the result exactly as a real check would. Backed
// by llm_families.js's buildNodePrompt/previewNodeResult/applyNodeResult
// and buildRelationPrompt/previewRelationResult/applyRelationResult. This
// verifies the app.js wiring end to end: opening the panel, the car
// picker(s) in both modes, building a prompt, running it against a mocked
// Ollama, pasting a hand-typed response, previewing it (including a
// hallucination-guard "dropped" case), and applying it into the ordinary
// review layer so the normal detail-panel Yes/No UI picks it up.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- ids ----------
const SOLO_ID = "m-test-pg-solo";
const FAM_ID = "fam-test-pg-gamma", G1_ID = "m-test-pg-gamma1", G2_ID = "m-test-pg-gamma2";
const DELTA_ID = "m-test-pg-delta";

const SOLO_WIKITEXT = "{{Infobox automobile\n| name = TestPgSolo Ish\n}}\n" +
  "The TestPgSolo Ish first generation P1 launched in 2001. The second generation P2 launched in 2010.";
const GAMMA_WIKITEXT = "{{Infobox automobile\n| name = TestPgGamma Ish\n}}\nA compact car nameplate with two generations.";
const DELTA_WIKITEXT = "{{Infobox automobile\n| name = TestPgDelta Ish\n}}\nA hatchback.";

let ollamaCalls = 0;
function makeFetch() {
  return (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      let wt = DELTA_WIKITEXT;
      if (u.includes("Solo")) wt = SOLO_WIKITEXT;
      else if (u.includes("Gamma")) wt = GAMMA_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    }
    if (u === "/api/llm/chat") {
      ollamaCalls++;
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: true,
          generations: [{ code: "P1", yearStart: 2001, yearEnd: 2010, designers: [], engineers: [] }],
        }) } }] }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
}

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = makeFetch();
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let mk1 = DATA.nodes.find(n => n.type === "make" && n.label === "TestPgMake");
if (!mk1) { mk1 = { id: "mk-test-pg1", type: "make", label: "TestPgMake", year: 1950 }; DATA.nodes.push(mk1); }
let mk2 = DATA.nodes.find(n => n.type === "make" && n.label === "TestPgMk");
if (!mk2) { mk2 = { id: "mk-test-pg2", type: "make", label: "TestPgMk", year: 1950 }; DATA.nodes.push(mk2); }
let mk3 = DATA.nodes.find(n => n.type === "make" && n.label === "TestPgMk2");
if (!mk3) { mk3 = { id: "mk-test-pg3", type: "make", label: "TestPgMk2", year: 1950 }; DATA.nodes.push(mk3); }

const solo = { id: SOLO_ID, type: "model", label: "Solo-ish", make: "TestPgMake", wp: "TestPgSolo Ish", year: 2001, end: null };
const fam = { id: FAM_ID, type: "family", label: "Gamma-ish", make: "TestPgMk", wp: "TestPgGamma Ish", year: 2000, end: null, designers: [], engineers: [], generations: [G1_ID, G2_ID] };
const g1 = { id: G1_ID, type: "model", label: "Gamma-ish I", make: "TestPgMk", year: 2000, end: 2008, familyOf: FAM_ID };
const g2 = { id: G2_ID, type: "model", label: "Gamma-ish II", make: "TestPgMk", year: 2008, end: null, familyOf: FAM_ID };
const delta = { id: DELTA_ID, type: "model", label: "Delta-ish", make: "TestPgMk2", wp: "TestPgDelta Ish", year: 2005, end: null };
DATA.nodes.push(solo, fam, g1, g2, delta);
DATA.links.push(
  { source: SOLO_ID, target: mk1.id, type: "made" },
  { source: FAM_ID, target: mk2.id, type: "made" },
  { source: DELTA_ID, target: mk3.id, type: "made" },
  { source: FAM_ID, target: G1_ID, type: "generation" }, { source: FAM_ID, target: G2_ID, type: "generation" },
  { source: G1_ID, target: G2_ID, type: "gensucc" },
);

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

function pick(inputId, query) {
  const input = window.document.getElementById(inputId);
  input.value = query;
  input.dispatchEvent(new window.Event("input"));
  const results = input.parentElement.querySelector(".llmpg-results");
  return { input, results };
}
function pickAndChoose(inputId, query, matchLabel) {
  const { input, results } = pick(inputId, query);
  const item = [...results.querySelectorAll(".sr-item")].find(el => el.textContent.includes(matchLabel));
  if (item) item.onmousedown({ preventDefault() {} });
  return item;
}

(async () => {
  const btn = window.document.getElementById("llmplaygroundbtn");
  const panel = window.document.getElementById("llmplayground");
  check("playground button is visible even though no entries exist yet (usable offline-first)", !btn.hidden);
  check("panel starts hidden", panel.hidden);
  btn.onclick();
  check("clicking the button opens the panel", !panel.hidden);

  // ---------- node mode ----------
  console.log("--- node mode ---");
  const soloItem = pickAndChoose("llmpg-node-pick", "Solo-ish", "Solo-ish");
  check("search found the synthetic Solo-ish car", !!soloItem);
  check("results hidden again after picking", window.document.getElementById("llmpg-node-pick").parentElement.querySelector(".llmpg-results").hidden);

  const buildBtn = window.document.getElementById("llmpg-build");
  const systemTa = window.document.getElementById("llmpg-system");
  const userTa = window.document.getElementById("llmpg-user");
  const responseTa = window.document.getElementById("llmpg-response");
  const output = window.document.getElementById("llmpg-output");

  buildBtn.onclick();
  await sleep(30);
  check("system prompt textarea populated", systemTa.value.length > 100);
  check("user prompt textarea names the actual car", userTa.value.includes("Solo-ish"));

  // -- "Run it here" against the mocked Ollama --
  const runBtn = window.document.getElementById("llmpg-run");
  const callsBefore = ollamaCalls;
  runBtn.onclick();
  await sleep(30);
  check("Run it here actually called Ollama", ollamaCalls === callsBefore + 1);
  check("the response textarea was filled in from the live call", responseTa.value.includes("P1"));

  // -- hand-edit the response to include a hallucinated code, then preview --
  responseTa.value = JSON.stringify({
    hasMultipleGenerations: true,
    generations: [
      { code: "P1", yearStart: 2001, yearEnd: 2010, designers: [], engineers: [] },
      { code: "P2", yearStart: 2010, yearEnd: null, designers: [], engineers: [] },
      { code: "GHOST", yearStart: 1999, yearEnd: 2000, designers: [], engineers: [] },
    ],
  });
  const previewBtn = window.document.getElementById("llmpg-preview");
  previewBtn.onclick();
  await sleep(30);
  check("preview kept both real generations (found verbatim in the mocked article)", output.textContent.includes("2 generations kept") && output.textContent.includes("P1") && output.textContent.includes("P2"));
  check("preview reports the hallucinated 'GHOST' code as dropped (hallucination guard working)", output.textContent.includes("Dropped") && output.textContent.includes("GHOST"));

  const applyBtn = window.document.getElementById("llmpg-apply");
  applyBtn.onclick();
  await sleep(30);
  const entry = window.LlmFamilies.entryFor(SOLO_ID);
  check("Apply wrote a real entry into the families store", !!entry);
  check("entry is marked as manually supplied", entry && entry.manuallySupplied === true);
  check("entry status is provisional (2 generations kept)", entry && entry.status === "provisional", entry && entry.status);
  check("confirmation message names the car and points at its detail panel", output.textContent.includes("Solo-ish") && output.textContent.includes("Saved"));

  // Real user request: a first-time nameplate creation needs no manual
  // approval -- opening the detail panel now auto-applies the playground-
  // supplied provisional entry immediately, exactly like a real check
  // would, instead of surfacing a Yes/No review box.
  cw.openDetail(solo);
  check("opening the detail panel auto-applied the playground-supplied provisional entry, exactly like a real check would",
    solo.type === "family" && solo.generations && solo.generations.length === 2, solo.type);

  // ---------- relation mode ----------
  console.log("--- relation mode ---");
  panel.hidden = false;
  const modeBtns = [...panel.querySelectorAll(".llmpg-mode")];
  const relModeBtn = modeBtns.find(b => b.dataset.mode === "relation");
  relModeBtn.onclick();
  check("mode tab switched to relation (active class)", relModeBtn.classList.contains("active"));
  check("node section hidden in relation mode", panel.querySelector('.llmpg-section[data-for="node"]').hidden);
  check("relation section visible in relation mode", !panel.querySelector('.llmpg-section[data-for="relation"]').hidden);

  const gammaItem = pickAndChoose("llmpg-rel-a", "Gamma-ish", "Gamma-ish");
  check("search found the synthetic Gamma-ish family for car A", !!gammaItem);
  const deltaItem = pickAndChoose("llmpg-rel-b", "Delta-ish", "Delta-ish");
  check("search found the synthetic Delta-ish model for car B", !!deltaItem);

  const relBuildBtn = window.document.getElementById("llmpg-build");
  relBuildBtn.onclick();
  await sleep(30);
  check("relation user prompt names both cars", userTa.value.includes("TestPgMk Gamma-ish") && userTa.value.includes("TestPgMk2 Delta-ish"), userTa.value.slice(0, 200));

  responseTa.value = JSON.stringify({ resolved: true, codeA: "Gamma-ish I", codeB: "Delta-ish", reason: "explicitly named together" });
  const relPreviewBtn = window.document.getElementById("llmpg-preview");
  relPreviewBtn.onclick();
  await sleep(30);
  check("relation preview resolved to provisional", output.textContent.includes("provisional"));
  check("relation preview pinned the specific Gamma-ish generation (I), not the whole nameplate", output.textContent.includes("Gamma-ish I"), output.textContent);

  const relApplyBtn = window.document.getElementById("llmpg-apply");
  relApplyBtn.onclick();
  await sleep(30);
  const key = [FAM_ID, DELTA_ID].sort().join("|") + "|related";
  const relEntry = window.LlmFamilies.relationEntryFor(key);
  check("Apply wrote a real relation entry into the store", !!relEntry);
  check("relation entry marked manually supplied", relEntry && relEntry.manuallySupplied === true);
  check("relation entry pinned the specific generation on car A", relEntry && relEntry.genIdA === G1_ID, relEntry && relEntry.genIdA);
  check("relation entry pinned car B (single-generation model, stands in for itself)", relEntry && relEntry.genIdB === DELTA_ID, relEntry && relEntry.genIdB);

  // ---------- error paths ----------
  console.log("--- error paths ---");
  const nodeModeBtn = modeBtns.find(b => b.dataset.mode === "node");
  nodeModeBtn.onclick();
  window.document.getElementById("llmpg-node-pick").value = "";
  // Force no car picked in node mode by re-running the picker logic without
  // choosing anything -- rebuild a fresh window state is overkill here;
  // instead just confirm Preview complains cleanly when the response box is
  // empty, and Build complains when nothing at all has been typed into the
  // response box yet for a bogus JSON case.
  responseTa.value = "{not valid json";
  const previewBtn2 = window.document.getElementById("llmpg-preview");
  previewBtn2.onclick();
  await sleep(30);
  check("pasting invalid JSON and clicking Preview shows a clean error, not a crash", output.textContent.toLowerCase().includes("json") || output.querySelector(".llmpg-result-error"));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
