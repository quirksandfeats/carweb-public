// Verifies the nameplate generation-list cross-check/override feature (a
// family's own generation list can be WRONG -- e.g. build_family_layer.py's
// BARE-FOLD pass folding a bare, un-suffixed "BMW X3" article in as if it
// were its own generation, right alongside the real X3 (G01)/(F25)/...).
// Three scenarios, matching a real bug report:
//   1. Same-session interactive apply: discrepancy shown -> Accept -> the
//      bogus generation is actually retired and the family's generation
//      list actually changes, AND a persistent confirmation is shown
//      instead of the panel just going silently blank.
//   2. A FRESH page load (fresh jsdom window, mimicking a real reload)
//      seeded from an already-"applied" recheck entry: the fix must still
//      be in effect WITHOUT re-clicking anything -- this was the actual bug
//      (nothing re-applied an "applied" entry at boot, so a reload reverted
//      straight back to the bogus generation list).
//   3. The LLM Debug panel: the override must be listed there and
//      individually deletable, and "Clear ALL" must wipe it too -- before
//      this fix, this whole layer had no presence in that panel at all.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
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

const FAM_ID = "fam-test-x3";
const BARE_ID = "m-test-x3-bare";
const G01_ID = "m-test-x3-g01";

// Seeds a synthetic build-time-style family (mirroring the real BMW X3 bug):
// a bare "X3" node with no suffix listed as one of its own generations,
// right alongside a real "X3 (G01)" generation that carries a designer
// credit -- so the test can verify that credit survives the bogus one being
// retired.
function seedFamily(DATA) {
  let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestBMW");
  if (!makeNode) { makeNode = { id: "mk-testbmw", type: "make", label: "TestBMW", year: 1916 }; DATA.nodes.push(makeNode); }
  const famNode = { id: FAM_ID, type: "family", label: "X3", make: "TestBMW", year: 2003, end: null,
    designers: [], engineers: [], generations: [BARE_ID, G01_ID] };
  const bareGen = { id: BARE_ID, type: "model", label: "X3", make: "TestBMW", year: 2003, end: 2010,
    familyOf: FAM_ID, wp: "TestBMW X3", designers: [], engineers: [] };
  const g01Gen = { id: G01_ID, type: "model", label: "X3 (G01)", make: "TestBMW", year: 2017, end: null,
    familyOf: FAM_ID, wp: "TestBMW X3 (G01)", designers: ["Test Designer"], engineers: [] };
  DATA.nodes.push(famNode, bareGen, g01Gen);
  DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" });
  DATA.links.push({ source: FAM_ID, target: BARE_ID, type: "generation" });
  DATA.links.push({ source: FAM_ID, target: G01_ID, type: "generation" });
  DATA.links.push({ source: BARE_ID, target: G01_ID, type: "gensucc" });
}

function freshWindow(llmFamiliesSeed) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("d3.min.js");
  loadScript("data.js");
  seedFamily(window.CARDATA);
  window.LLM_FAMILIES = llmFamiliesSeed;
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");
  return window;
}

const freshProposal = {
  hasMultipleGenerations: true,
  generations: [{ code: "G01", yearStart: 2017, yearEnd: null, designers: ["Test Designer"], engineers: [] }],
};

// ---------- scenario 1: same-session interactive apply ----------
{
  const seed = {
    families: {}, relations: {},
    recheck: {
      [FAM_ID]: {
        status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "TestBMW X3",
        proposal: freshProposal,
        discrepancy: "an existing generation here is really just the bare nameplate itself",
        attempts: 1, feedback: [],
      },
    },
    __serverAvailable: true,
  };
  const window = freshWindow(seed);
  const cw = window.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);
  const fam = cw.byId.get(FAM_ID);
  check("precondition: family starts with the bogus bare generation", fam.generations.includes(BARE_ID));

  cw.openDetail(fam);
  const label = window.document.querySelector(".dt-llmcheck .llm-label");
  check("discrepancy surfaced in the detail panel", !!label, label && label.textContent);
  const yesBtn = window.document.querySelector(".dt-llmcheck .llm-yes");
  check("Accept button rendered", !!yesBtn);
  yesBtn.onclick();

  check("bogus bare generation removed from the family's generation list", !fam.generations.includes(BARE_ID), fam.generations);
  check("real G01 generation kept (same id, not re-minted)", fam.generations.includes(G01_ID), fam.generations);
  check("family's generation count actually changed (1, not still 2)", fam.generations.length === 1, fam.generations.length);
  const bare = cw.byId.get(BARE_ID);
  check("bogus node is retired, not deleted from the arrays", bare.retired === true);
  check("retired node is hidden from nodeInLayer everywhere", !cw.nodeInLayer(bare));
  check("recheck entry transitioned to 'applied'", window.LlmFamilies.recheckEntryFor(FAM_ID).status === "applied");

  const afterHtml = window.document.querySelector(".dt-llmcheck").innerHTML;
  check("a persistent confirmation is shown instead of the panel going blank", afterHtml.includes("Applied"), afterHtml);

  const dtGenHtml = window.document.querySelector(".dt-generations").innerHTML;
  check("detail panel's own Generations list reflects the fix immediately (no bare X3 row)", !dtGenHtml.includes(">X3<"), dtGenHtml);
  check("detail panel's Generations list shows the real G01 generation", dtGenHtml.includes("X3 (G01)"), dtGenHtml);

  // ---------- whole-graph integrity: the actual "entire screen goes blank" bug ----------
  // applyFamilyOverrideConfirm rebuilds adj/sn/tn for EVERY link, not just
  // the ones the override touched -- by this point buildSim() has already
  // run at least once (during the initial cw.boot() above), and d3-force's
  // link force mutates link.source/target from plain id strings into direct
  // node object references the moment it initializes. A naive byId.get()
  // (which only understands the string form) on every other, untouched
  // link in the whole ~20k-link graph would silently resolve to undefined,
  // which crashes Graph's draw loop the instant it reads .x off an
  // undefined l.sn/l.tn -- invisible in this headless test (canvas draws
  // are stubbed out) but exactly the "whole screen goes blank, need to
  // refresh" bug in a real browser. Assert the invariant directly: every
  // non-retired link must still resolve to real node objects whose own id
  // matches link.source/target, for the WHOLE graph, not just this test's
  // synthetic corner of it.
  // buildSim() runs again at the end of applyFamilyOverrideConfirm, which
  // means d3-force's link force re-mutates link.source/target from the
  // just-normalized id strings BACK into direct node object references one
  // more time -- that's the expected, converged end state (not corruption),
  // so a valid link.source/target is either the matching id string OR the
  // exact same object as l.sn/l.tn.
  let brokenLinks = 0;
  for (const l of cw.links) {
    if (l.retired) continue;
    const sOk = l.sn && (l.sn.id === l.source || l.sn === l.source);
    const tOk = l.tn && (l.tn.id === l.target || l.tn === l.target);
    if (!sOk || !tOk) brokenLinks++;
  }
  check("every link in the whole graph still resolves to real sn/tn node objects after the override (no whole-screen-blank corruption)",
    brokenLinks === 0, brokenLinks + " broken link(s) out of " + cw.links.length);
}

// ---------- scenario 2: fresh page load from an already-"applied" entry ----------
{
  const seed = {
    families: {}, relations: {},
    recheck: {
      [FAM_ID]: {
        status: "applied", checkedAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
        sourceTitle: "TestBMW X3", proposal: freshProposal,
        discrepancy: "an existing generation here is really just the bare nameplate itself",
        attempts: 1, feedback: [],
      },
    },
    // Deliberately serverAvailable:false -- this is exactly what a plain
    // double-clicked index.html (file://, no serve.py) sees, and
    // applyAllFamilyOverrides is deliberately NOT gated on serverAvailable
    // (same reasoning as applyConfirmed's own "Deliberately NOT gated"
    // comment: a static build should render an already-decided override
    // identically to the live session that made it) -- only the
    // *interactive* confirmation UI is gated behind serverAvailable, tested
    // separately below with a live session.
    __serverAvailable: false,
  };
  const window = freshWindow(seed);
  const cw = window.CarWeb;
  cw.boot(); // no interaction at all -- this alone must reproduce the fix

  const fam = cw.byId.get(FAM_ID);
  check("an already-'applied' override is reproduced on a completely fresh boot, no clicks needed",
    fam.generations.length === 1 && fam.generations.includes(G01_ID) && !fam.generations.includes(BARE_ID),
    fam.generations);
  const bare = cw.byId.get(BARE_ID);
  check("the bogus generation is retired again on this fresh boot too", bare.retired === true);
  check("nodeInLayer hides it here too", !cw.nodeInLayer(bare));

  // Same scenario, but a live (serverAvailable:true) session re-opening the
  // panel -- this is the realistic "closed and reopened the app while
  // serve.py kept running" case, and IS expected to show the confirmation.
  const liveWindow = freshWindow(Object.assign({}, seed, { __serverAvailable: true }));
  const cwLive = liveWindow.CarWeb;
  cwLive.boot();
  cwLive.openDetail(cwLive.byId.get(FAM_ID));
  const html2 = liveWindow.document.querySelector(".dt-llmcheck").innerHTML;
  check("re-opening an already-applied nameplate (live session) shows the confirmation, not a re-run of the check",
    html2.includes("Applied"), html2);
}

// ---------- scenario 3: LLM Debug panel visibility + delete ----------
{
  const seed = {
    families: {}, relations: {},
    recheck: {
      [FAM_ID]: {
        status: "applied", checkedAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
        sourceTitle: "TestBMW X3", proposal: freshProposal,
        discrepancy: "an existing generation here is really just the bare nameplate itself",
        attempts: 1, feedback: [],
      },
    },
    __serverAvailable: true,
  };
  const window = freshWindow(seed);
  const cw = window.CarWeb;
  cw.boot();

  const recheckEntries = window.LlmFamilies.allRecheckEntries();
  check("the override is listed via allRecheckEntries()", recheckEntries.some(e => e.id === FAM_ID && e.status === "applied"), recheckEntries);

  window.LlmFamilies.deleteRecheckEntry(FAM_ID);
  check("deleteRecheckEntry() removed it from the live store", !window.LlmFamilies.recheckEntryFor(FAM_ID));

  // Mirrors what the debug panel's delete button actually does after this:
  // location.reload(). Simulate with a fresh window seeded from what's left
  // (nothing) and confirm the graph reverts to the untouched original.
  const windowAfterDelete = freshWindow({ families: {}, relations: {}, recheck: {}, __serverAvailable: true });
  const cw2 = windowAfterDelete.CarWeb;
  cw2.boot();
  const famAfter = cw2.byId.get(FAM_ID);
  check("deleting via the debug panel + reload reverts to the original (bogus) generation list",
    famAfter.generations.includes(BARE_ID) && famAfter.generations.length === 2, famAfter.generations);

  // resetAll() ("Clear ALL") must also wipe recheck entries, not just families.
  const window3 = freshWindow(seed);
  const cw3 = window3.CarWeb;
  cw3.boot();
  window3.LlmFamilies.resetAll();
  check("resetAll() ('Clear ALL') wipes recheck entries too", Object.keys(window3.LlmFamilies.allRecheckEntries()).length === 0 &&
    window3.LlmFamilies.allRecheckEntries().length === 0);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
