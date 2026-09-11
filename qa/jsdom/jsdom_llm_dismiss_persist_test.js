// Real bug report: "even though I clear the positive (and negative) llm
// messages, they reappear after a refresh." Dismissing a message (either
// the individual close button, or the debug panel's bulk "Clear all
// positive messages") used to only ever touch app.js's own in-memory,
// session-only dismissedLlm Set -- by original design, on the reasoning
// that a fresh check might show something genuinely new. That reasoning
// doesn't hold for a plain page refresh, which re-renders the SAME
// already-decided entry, not a new one. Dismissals are now persisted
// through window.LlmFamilies's store.dismissed, round-tripped via
// serve.py's /api/llm-families exactly like every other decision in this
// layer (see llm_families.js's own comment on store.dismissed).
//
// This test simulates an actual page reload: window A dismisses two
// messages (one individual close, one via the bulk "Clear all positive
// messages" button) and its outgoing /api/llm-families POST body is
// captured; window B then boots FRESH, seeded with exactly that captured
// body as its own window.LLM_FAMILIES (i.e. "what serve.py would now have
// on disk and serve back on the next page load") -- and both dismissed
// messages must stay gone with zero further action, proving persistence
// survives a real reload rather than just surviving within one page's
// lifetime.
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

function freshWindow({ fetchImpl, seed, llmFamilies } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = fetchImpl || (() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("d3.min.js");
  loadScript("data.js");
  if (typeof seed === "function") seed(window.CARDATA);
  window.LLM_FAMILIES = llmFamilies || { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  return window;
}

const FAM_ID = "fam-test-dismisspersist", BARE_ID = "m-test-dismisspersist-bare", G01_ID = "m-test-dismisspersist-g01";
const FAM_A = "fam-test-dismisspersist-a", FAM_B = "fam-test-dismisspersist-b";
const A1 = "m-test-dismisspersist-a1", B1 = "m-test-dismisspersist-b1";
function seed(DATA) {
  let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestDismissPersist");
  if (!mk) { mk = { id: "mk-testdismisspersist", type: "make", label: "TestDismissPersist", year: 1950 }; DATA.nodes.push(mk); }
  const fam = { id: FAM_ID, type: "family", label: "Iota", make: "TestDismissPersist", year: 2003, end: null,
    designers: [], engineers: [], generations: [BARE_ID, G01_ID] };
  const bare = { id: BARE_ID, type: "model", label: "Iota", make: "TestDismissPersist", year: 2003, end: 2010, familyOf: FAM_ID, wp: "TestDismissPersist Iota" };
  const g01 = { id: G01_ID, type: "model", label: "Iota (G01)", make: "TestDismissPersist", year: 2017, end: null, familyOf: FAM_ID, wp: "TestDismissPersist Iota (G01)" };
  const famA = { id: FAM_A, type: "family", label: "Kappa", make: "TestDismissPersist", year: 2000, end: null, generations: [A1] };
  const famB = { id: FAM_B, type: "family", label: "Lambda", make: "TestDismissPersist", year: 2005, end: null, generations: [B1] };
  const a1 = { id: A1, type: "model", label: "Kappa (I)", make: "TestDismissPersist", familyOf: FAM_A, year: 2000, end: null };
  const b1 = { id: B1, type: "model", label: "Lambda (I)", make: "TestDismissPersist", familyOf: FAM_B, year: 2005, end: null };
  DATA.nodes.push(fam, bare, g01, famA, famB, a1, b1);
  DATA.links.push({ source: FAM_ID, target: mk.id, type: "made" }, { source: FAM_A, target: mk.id, type: "made" }, { source: FAM_B, target: mk.id, type: "made" });
  DATA.links.push({ source: FAM_ID, target: BARE_ID, type: "generation" }, { source: FAM_ID, target: G01_ID, type: "generation" }, { source: BARE_ID, target: G01_ID, type: "gensucc" });
  DATA.links.push({ source: FAM_A, target: A1, type: "generation" }, { source: FAM_B, target: B1, type: "generation" });
  DATA.links.push({ source: FAM_A, target: FAM_B, type: "related" });
}
const proposal = { hasMultipleGenerations: true, generations: [{ code: "G01", yearStart: 2017, yearEnd: null, designers: [], engineers: [] }] };
const relKey = [FAM_A, FAM_B].sort().join("|") + "|related";

// ---------- window A: seed two positive messages, dismiss both, capture the persisted POST body ----------
let lastPersistedBody = null;
const winA = freshWindow({
  seed,
  fetchImpl: (url, opts) => {
    if (url === "/api/llm-families" && opts && opts.method === "POST") {
      lastPersistedBody = JSON.parse(opts.body);
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  },
  llmFamilies: {
    families: {},
    recheck: {
      [FAM_ID]: { status: "applied", checkedAt: new Date().toISOString(), appliedAt: new Date().toISOString(), sourceTitle: "TestDismissPersist Iota", proposal, attempts: 1, feedback: [] },
    },
    relations: {
      [relKey]: { famA: FAM_A, famB: FAM_B, relType: "related", status: "confirmed", codeA: "Kappa (I)", codeB: "Lambda (I)", checkedAt: new Date().toISOString() },
    },
    __serverAvailable: true,
  },
});
{
  const cw = winA.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);

  // Individual close on the resolved relation message.
  cw.openDetail(cw.byId.get(FAM_A));
  const resolvedDiv = winA.document.querySelector(".dt-relations .llm-resolved");
  check("window A: resolved relation message showing before dismissal", !!resolvedDiv);
  if (resolvedDiv) resolvedDiv.querySelector(".llm-close").onclick();
  check("window A: individual close persisted a POST to /api/llm-families", !!lastPersistedBody);
  check("window A: persisted body now includes a 'dismissed' map with the relation key",
    !!(lastPersistedBody && lastPersistedBody.dismissed && Object.keys(lastPersistedBody.dismissed).some(k => k.includes(relKey))),
    lastPersistedBody && lastPersistedBody.dismissed);

  // Bulk "Clear all positive messages" on the applied family message.
  cw.openDetail(cw.byId.get(FAM_ID));
  check("window A: 'applied' message showing before bulk clear", !!winA.document.querySelector(".dt-llmcheck .llm-applied"));
  winA.document.getElementById("llmdebugbtn").onclick();
  const clearPositiveBtn = winA.document.getElementById("llmdebug-clearpositive");
  check("window A: bulk clear button exists and is enabled", !!clearPositiveBtn && !clearPositiveBtn.disabled);
  clearPositiveBtn.onclick();
  check("window A: bulk clear also persisted (dismissed map now includes the applied:<id> key too)",
    !!(lastPersistedBody && lastPersistedBody.dismissed && Object.keys(lastPersistedBody.dismissed).some(k => k.includes(FAM_ID))),
    lastPersistedBody && lastPersistedBody.dismissed);
}

// ---------- window B: fresh boot, seeded with exactly what window A persisted -- simulates a real page reload ----------
const winB = freshWindow({
  seed,
  llmFamilies: Object.assign({ __serverAvailable: true }, lastPersistedBody || {}),
});
{
  const cw = winB.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);

  cw.openDetail(cw.byId.get(FAM_A));
  check("window B (reload): resolved relation message does NOT reappear", !winB.document.querySelector(".dt-relations .llm-resolved"));

  cw.openDetail(cw.byId.get(FAM_ID));
  check("window B (reload): applied family message does NOT reappear", !winB.document.querySelector(".dt-llmcheck .llm-applied"));

  // The underlying decisions themselves must still be intact -- dismissal
  // is a UI-only "stop showing me this", never a data deletion.
  check("window B (reload): underlying 'applied' entry is still status applied (data itself untouched)",
    winB.LlmFamilies.recheckEntryFor(FAM_ID) && winB.LlmFamilies.recheckEntryFor(FAM_ID).status === "applied");
  check("window B (reload): underlying 'confirmed' relation entry is still status confirmed (data itself untouched)",
    winB.LlmFamilies.relationEntryFor(relKey) && winB.LlmFamilies.relationEntryFor(relKey).status === "confirmed");
}

// ---------- "Clear ALL" in the debug panel must also wipe dismissals, not just leave them stranded ----------
(async () => {
  const winC = freshWindow({
    seed,
    llmFamilies: Object.assign({ __serverAvailable: true }, lastPersistedBody || {}),
  });
  check("window C: dismissed map is non-empty before resetAll", winC.LlmFamilies.allDismissed().length > 0, winC.LlmFamilies.allDismissed());
  await winC.LlmFamilies.resetAll();
  check("resetAll ('Clear ALL') also wipes dismissals", winC.LlmFamilies.allDismissed().length === 0, winC.LlmFamilies.allDismissed());

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
