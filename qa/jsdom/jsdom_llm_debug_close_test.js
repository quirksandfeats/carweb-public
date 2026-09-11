// Verifies a real user report, three parts:
//  1. The infobox's "related"/"platform" field (Wikipedia's Body and
//     chassis group) is pulled out explicitly and put in front of the
//     model, instead of relying on it being noticed somewhere inside a huge
//     raw infobox blob -- this is also why retry-with-feedback looked like
//     it did nothing: the info was never in the model's context to act on
//     in the first place.
//  2. Every LLM result box (generation check -- both "provisional" and
//     "none" -- family recheck, and relation check) gets a "see what it
//     said" debug disclosure, not just the one place that already had it.
//  3. Every closeable LLM message -- dead-end verdicts ("none"/error) AND
//     messages reporting a COMPLETED match (a resolved relation, an applied
//     nameplate correction) -- fully clears on Close, dismissal remembered
//     for the rest of the session. (Earlier behavior collapsed completed-
//     match messages to a small permanent "via local LLM + Wikipedia"
//     disclaimer instead of clearing fully; real user request: "I don't
//     need the text 'via local LLM + Wikipedia' to remain. I just want to
//     clear the message and have it be cleared simply.")
//  4. A "Clear all positive messages" bulk action in the LLM Debug panel
//     dismisses every currently-showing "applied"/"resolved" (matched, no
//     error) message across the whole session in one click, without
//     touching "none"/error dead-ends or deleting any underlying data.
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

function freshWindow({ fetchImpl, seed } = {}) {
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
  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");
  return window;
}

async function scenario1_extractionAndNoneClose() {
  console.log("--- scenario 1: infobox field extraction + 'none' debug/close ---");
  // A real-shaped infobox: "related" sits deep in a "Body and chassis"
  // group, surrounded by a dozen unrelated fields, with no prose sentence
  // anywhere announcing it -- only dedicated field extraction can find it.
  const WIKITEXT = `{{Infobox automobile
| name = TestCorsa Rebadge
| manufacturer = TestCo
| production = 2018-2024
| class = Supermini
| body_style = 5-door hatchback
| layout = FF layout
| platform = TestCo PF1 platform
| related = TestCo Rebadge Twin
| doors = 5
| engine = 1.2L I3
}}
The second generation was launched in 2018 with a new design.`;
  let lastBody = null;
  const window = freshWindow({
    fetchImpl: (url, opts) => {
      const u = String(url);
      if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
        return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
      }
      if (u === "/api/llm/chat") {
        lastBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hasMultipleGenerations: false, generations: [] }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    },
  });
  const cw = window.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);
  const logan = cw.byId.get("m-dacia-logan");
  cw.openDetail(logan);
  await sleep(60);

  const msgText = lastBody ? JSON.stringify(lastBody.messages) : "";
  check("infobox 'platform' field reached the outgoing prompt as its own labeled line", msgText.includes("TestCo PF1 platform"), msgText.slice(0, 200));
  check("infobox 'related' field reached the outgoing prompt as its own labeled line", msgText.includes("TestCo Rebadge Twin"), msgText.slice(0, 200));

  const noneStatus = window.document.querySelector(".dt-llmcheck .llm-status");
  check("'none' verdict rendered", !!noneStatus && noneStatus.textContent.includes("no multiple generations"), noneStatus && noneStatus.textContent);
  const debugBtn = window.document.querySelector(".dt-llmcheck .llm-debug-toggle");
  check("debug toggle present on a 'none' result", !!debugBtn);
  const closeBtn = window.document.querySelector(".dt-llmcheck .llm-close");
  check("Close button present on a 'none' result", !!closeBtn);
  // NOTE: ".dt-llmcheck" is no longer empty after a dismissal, and shouldn't
  // be -- app.js's renderLlmCheck now always appends a persistent Wikipedia-
  // link row (renderWpLinkRow) below whatever the check itself is showing,
  // deliberately OUTSIDE the body element these Close buttons clear, so the
  // "add/change this car's Wikipedia link" affordance survives dismissing a
  // message. What "cleared" means for a dismissal is therefore: no status
  // text, no debug disclosure, no close button left -- checked directly
  // rather than via the container's total emptiness.
  const llmMessageGone = () => {
    const el = window.document.querySelector(".dt-llmcheck");
    return !el.querySelector(".llm-status") && !el.querySelector(".llm-close") &&
           !el.querySelector(".llm-applied") && !el.querySelector(".llm-debug-toggle");
  };
  closeBtn.onclick();
  check("clicking Close removes the message entirely (no longer persistent)", llmMessageGone());

  cw.openDetail(cw.byId.get("m-ford-galaxy"));
  cw.openDetail(logan);
  check("dismissal is remembered for the rest of the session (reopening doesn't bring it back)", llmMessageGone());
}

function scenario2_provisionalAutoApplies() {
  console.log("--- scenario 2: generation-check 'provisional' auto-applies, no debug/review box ---");
  // Real user request: "if a car is creating a nameplate for the first
  // time... you do not need my approval to turn it into a nameplate. Simply
  // do so without my request." A seeded "provisional" model-level entry
  // (mirroring what a real checkNode() would have left behind) now applies
  // itself the instant the detail panel renders it -- no Yes/No/Retry
  // review box, and so no debug toggle for that box either (there's nothing
  // left to inspect before deciding, since nothing is decided by hand
  // anymore).
  const TEST_ID = "m-dacia-logan";
  const window = freshWindow({
    seed: () => {},
  });
  window.LLM_FAMILIES = {
    families: {
      [TEST_ID]: {
        status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "Dacia Logan",
        proposal: { hasMultipleGenerations: true, generations: [
          { code: "Second generation", yearStart: 2012, yearEnd: 2020, designers: [], engineers: [] },
          { code: "Third generation", yearStart: 2020, yearEnd: null, designers: [], engineers: [] },
        ] },
        attempts: 1, feedback: [],
        debug: { raw: { hasMultipleGenerations: true }, dropped: [{ code: "Phase 9", yearStart: 2099 }] },
      },
    },
    relations: {}, recheck: {}, __serverAvailable: true,
  };
  // Re-run the two scripts that actually read window.LLM_FAMILIES (llm_families.js
  // captured it at module-eval time above via freshWindow's own loadScript
  // call, which already ran with an EMPTY seed) -- reload both fresh so this
  // window's LlmFamilies module picks up the seeded data.
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");
  const cw = window.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);
  const logan = cw.byId.get(TEST_ID);
  cw.openDetail(logan);

  check("no Yes/No/Retry proposal box is ever shown", !window.document.querySelector(".dt-llmcheck .llm-label"));
  check("no debug toggle either -- there's nothing left to review before deciding", !window.document.querySelector(".dt-llmcheck .llm-debug-toggle"));
  check("the entry auto-confirmed itself", window.LlmFamilies.entryFor(TEST_ID) && window.LlmFamilies.entryFor(TEST_ID).status === "confirmed");
  check("the plain model actually became a real family, with no click required", logan.type === "family", logan.type);
}

function scenario3_familyRecheckDebugAndAppliedClose() {
  console.log("--- scenario 3: family recheck debug toggle + 'applied' close-to-disclaimer ---");
  const FAM_ID = "fam-test-dbgclose";
  const BARE_ID = "m-test-dbgclose-bare";
  const G01_ID = "m-test-dbgclose-g01";
  function seed(DATA) {
    let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestBMW3");
    if (!makeNode) { makeNode = { id: "mk-testbmw3", type: "make", label: "TestBMW3", year: 1916 }; DATA.nodes.push(makeNode); }
    const famNode = { id: FAM_ID, type: "family", label: "X5", make: "TestBMW3", year: 2003, end: null,
      designers: [], engineers: [], generations: [BARE_ID, G01_ID] };
    const bareGen = { id: BARE_ID, type: "model", label: "X5", make: "TestBMW3", year: 2003, end: 2010,
      familyOf: FAM_ID, wp: "TestBMW3 X5", designers: [], engineers: [] };
    const g01Gen = { id: G01_ID, type: "model", label: "X5 (G01)", make: "TestBMW3", year: 2017, end: null,
      familyOf: FAM_ID, wp: "TestBMW3 X5 (G01)", designers: [], engineers: [] };
    DATA.nodes.push(famNode, bareGen, g01Gen);
    DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" });
    DATA.links.push({ source: FAM_ID, target: BARE_ID, type: "generation" });
    DATA.links.push({ source: FAM_ID, target: G01_ID, type: "generation" });
    DATA.links.push({ source: BARE_ID, target: G01_ID, type: "gensucc" });
  }
  const proposal = { hasMultipleGenerations: true, generations: [{ code: "G01", yearStart: 2017, yearEnd: null, designers: [], engineers: [] }] };

  // ---------- 3a: discrepancy (provisional) debug toggle ----------
  {
    const window = freshWindow({ seed });
    window.LLM_FAMILIES = {
      families: {},
      recheck: { [FAM_ID]: {
        status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "TestBMW3 X5",
        proposal, discrepancy: "an existing generation here is really just the bare nameplate itself",
        attempts: 1, feedback: [], debug: { raw: { hasMultipleGenerations: true }, dropped: [] },
      } },
      relations: {}, __serverAvailable: true,
    };
    function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
    loadScript("llm_families.js");
    loadScript("app.js");
    loadScript("timeline.js");
    loadScript("sixdeg.js");
  loadScript("platforms.js");
    const cw = window.CarWeb;
    cw.boot();
    cw.setLlmCheck(true);
    cw.openDetail(cw.byId.get(FAM_ID));
    const debugBtn = window.document.querySelector(".dt-llmcheck .llm-debug-toggle");
    check("debug toggle now present on a family recheck discrepancy (previously missing)", !!debugBtn);
  }

  // ---------- 3b: applied -- Close fully clears the message ----------
  {
    const window = freshWindow({ seed });
    window.LLM_FAMILIES = {
      families: {},
      recheck: { [FAM_ID]: {
        status: "applied", checkedAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
        sourceTitle: "TestBMW3 X5", proposal,
        discrepancy: "an existing generation here is really just the bare nameplate itself",
        attempts: 1, feedback: [],
      } },
      relations: {}, __serverAvailable: true,
    };
    function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
    loadScript("llm_families.js");
    loadScript("app.js");
    loadScript("timeline.js");
    loadScript("sixdeg.js");
  loadScript("platforms.js");
    const cw = window.CarWeb;
    cw.boot();
    cw.setLlmCheck(true);
    cw.openDetail(cw.byId.get(FAM_ID));

    const applied = window.document.querySelector(".dt-llmcheck .llm-applied");
    check("'Applied' confirmation shown", !!applied, applied && applied.textContent);
    const closeBtn = window.document.querySelector(".dt-llmcheck .llm-close");
    check("Close button present on the 'Applied' confirmation", !!closeBtn);
    closeBtn.onclick();
    // Same "the persistent Wikipedia-link row is not residual text" caveat as
    // scenario 1 above -- see its own note.
    const el2 = window.document.querySelector(".dt-llmcheck");
    check("closing fully clears the message -- no disclaimer, no residual text",
      !el2.querySelector(".llm-status") && !el2.querySelector(".llm-close") && !el2.querySelector(".llm-applied"));
    check("the full 'Applied' banner is gone", !window.document.querySelector(".dt-llmcheck .llm-applied"));

    // Reopening (e.g. after navigating away and back) must not bring it
    // back. Re-rendering the panel now always re-appends the manual "🔄 LLM
    // Re-check" trigger (task #120, see app.js's renderManualRecheckButton)
    // regardless of dismissal state, so .dt-llmcheck itself is no longer
    // expected to go fully empty on reopen -- what matters is that the
    // dismissed "Applied" banner specifically doesn't come back.
    cw.openDetail(cw.byId.get(G01_ID));
    cw.openDetail(cw.byId.get(FAM_ID));
    const reopenedHtml = window.document.querySelector(".dt-llmcheck").innerHTML.trim();
    check("dismissal remembered for the rest of the session", !/llm-applied/.test(reopenedHtml), reopenedHtml);
    check("...but the manual re-check trigger still shows on reopen", /llm-recheck-btn/.test(reopenedHtml), reopenedHtml);
  }
}

async function scenario4_relationNoneAndResolvedClose() {
  console.log("--- scenario 4: relation check 'none' debug/close + resolved close-to-disclaimer ---");
  // A clean synthetic pair (unlike Porsche 911's real data, which carries a
  // pile of OTHER platform/related/succession links too -- see
  // jsdom_relation_disambiguation_test.js's own comment) with exactly ONE
  // relation candidate, so there's no ambiguity about which rendered box is
  // under test.
  const FAM_A = "fam-test-dbgclose-a", FAM_B = "fam-test-dbgclose-b";
  const A1 = "m-test-dbgclose-a1", A2 = "m-test-dbgclose-a2", B1 = "m-test-dbgclose-b1", B2 = "m-test-dbgclose-b2";
  function seed(DATA) {
    let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestDbgMake");
    if (!mk) { mk = { id: "mk-testdbgclose", type: "make", label: "TestDbgMake", year: 1950 }; DATA.nodes.push(mk); }
    const famA = { id: FAM_A, type: "family", label: "Alpha", make: "TestDbgMake", year: 2000, end: null, generations: [A1, A2] };
    const famB = { id: FAM_B, type: "family", label: "Beta", make: "TestDbgMake", year: 2005, end: null, generations: [B1, B2] };
    const a1 = { id: A1, type: "model", label: "Alpha (I)", make: "TestDbgMake", familyOf: FAM_A, year: 2000, end: 2010 };
    const a2 = { id: A2, type: "model", label: "Alpha (II)", make: "TestDbgMake", familyOf: FAM_A, year: 2010, end: null };
    const b1 = { id: B1, type: "model", label: "Beta (I)", make: "TestDbgMake", familyOf: FAM_B, year: 2005, end: 2015 };
    const b2 = { id: B2, type: "model", label: "Beta (II)", make: "TestDbgMake", familyOf: FAM_B, year: 2015, end: null };
    DATA.nodes.push(famA, famB, a1, a2, b1, b2);
    DATA.links.push({ source: FAM_A, target: mk.id, type: "made" }, { source: FAM_B, target: mk.id, type: "made" });
    DATA.links.push({ source: FAM_A, target: A1, type: "generation" }, { source: FAM_A, target: A2, type: "generation" });
    DATA.links.push({ source: FAM_B, target: B1, type: "generation" }, { source: FAM_B, target: B2, type: "generation" });
    // The `note` is load-bearing as of the no-evidence short-circuit in
    // llm_families.js's checkRelation (real user report: "the LLM tried to
    // check a relationship between the Pontiac G5 and the Marcos TSO, even
    // though it knew they weren't related"). A pair with no note, no article
    // text mentioning the other car, and no chassis code found in either one
    // has nothing to resolve a specific generation pair from, so the check
    // now returns "none" without spending a llama.cpp call at all. These
    // synthetic fixtures have no Wikipedia articles to gather evidence from,
    // so without a note they would take that short-circuit and this scenario
    // -- which is about the review UI on a REAL model verdict, not about the
    // evidence gate -- would never reach the model at all.
    DATA.links.push({ source: FAM_A, target: FAM_B, type: "related", note: "Alpha and Beta are described as sister models sharing a platform." });
  }
  const window = freshWindow({
    seed,
    fetchImpl: (url, opts) => {
      const u = String(url);
      if (u === "/api/llm/chat") {
        const body = JSON.parse(opts.body);
        if (window.__wantResolved) {
          // Order-agnostic: app.js always views the CURRENTLY-OPEN nameplate
          // as "Car A" in the outgoing prompt, so which side that actually
          // is can flip depending on which panel triggered the check.
          const aIsAlpha = JSON.stringify(body.messages).includes("Car A -- TestDbgMake Alpha");
          const answer = aIsAlpha
            ? { resolved: true, codeA: "Alpha (I)", codeB: "Beta (I)", reason: "overlapping years" }
            : { resolved: true, codeA: "Beta (I)", codeB: "Alpha (I)", reason: "overlapping years" };
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: true, codeA: "nope", codeB: "nope", reason: "bad guess" }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    },
  });
  const cw = window.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);
  const famA = cw.byId.get(FAM_A), famB = cw.byId.get(FAM_B);
  cw.openDetail(famA);
  await sleep(60);

  const noneStatus = window.document.querySelector(".dt-relations .llm-status");
  check("relation 'none' verdict rendered (bogus codes didn't match)", !!noneStatus && noneStatus.textContent.includes("couldn't confidently match"), noneStatus && noneStatus.textContent);
  const debugBtn = window.document.querySelector(".dt-relations .llm-debug-toggle");
  check("debug toggle present on a relation-check 'none' result", !!debugBtn);
  debugBtn.onclick();
  const debugBox = window.document.querySelector(".dt-relations .llm-debug");
  check("debug box shows the codes that were actually offered", !debugBox.hidden && debugBox.innerHTML.includes("codes offered"), debugBox.innerHTML);
  const closeBtn = window.document.querySelector(".dt-relations .llm-close");
  check("Close button present on a relation-check 'none' result", !!closeBtn);
  closeBtn.onclick();
  check("closing removes the relation-check box", !window.document.querySelector(".dt-relations .llm-status"));

  // ---------- now let a retry succeed, confirm it, then close the resolved confirmation ----------
  window.LlmFamilies.rejectRelation([FAM_A, FAM_B].sort().join("|") + "|related");
  window.__wantResolved = true;
  cw.openDetail(famA);
  await sleep(60);

  const relYes = window.document.querySelector(".dt-relations .llm-rel-yes");
  check("retry produced a genuine resolvable match", !!relYes);
  if (relYes) relYes.onclick();
  cw.openDetail(famA);

  const resolvedDiv = window.document.querySelector(".dt-relations .llm-resolved");
  check("resolved confirmation shown with a close button", !!resolvedDiv && !!resolvedDiv.querySelector(".llm-close"), resolvedDiv && resolvedDiv.innerHTML);
  if (resolvedDiv) {
    resolvedDiv.querySelector(".llm-close").onclick();
    check("closing the resolved confirmation fully removes it -- no disclaimer left behind",
      !window.document.querySelector(".dt-relations .llm-resolved"));
    cw.openDetail(famB);
    cw.openDetail(famA);
    check("dismissal remembered for the rest of the session (reopening doesn't bring it back)",
      !window.document.querySelector(".dt-relations .llm-resolved"));
  }
}

function scenario5_clearAllPositiveMessages() {
  console.log("--- scenario 5: 'Clear all positive messages' bulk action ---");
  // Real user request: "having a 'clear all positive messages' should be an
  // option, where only the messages that had matches and without errors can
  // all be cleared at once." Seeds one "applied" family recheck AND one
  // "confirmed" relation match, both already-persisted (not freshly
  // resolved this session), and confirms ONE button click dismisses both --
  // without touching an unrelated "none" dead-end, and without deleting the
  // underlying persisted entries (a reload/reopen elsewhere would still see
  // them as applied/confirmed; only the session-local dismissal changes).
  const FAM_ID = "fam-test-clearpos", BARE_ID = "m-test-clearpos-bare", G01_ID = "m-test-clearpos-g01";
  const FAM_A = "fam-test-clearpos-a", FAM_B = "fam-test-clearpos-b";
  const A1 = "m-test-clearpos-a1", B1 = "m-test-clearpos-b1";
  function seed(DATA) {
    let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestClearPos");
    if (!mk) { mk = { id: "mk-testclearpos", type: "make", label: "TestClearPos", year: 1950 }; DATA.nodes.push(mk); }
    const fam = { id: FAM_ID, type: "family", label: "Zeta", make: "TestClearPos", year: 2003, end: null,
      designers: [], engineers: [], generations: [BARE_ID, G01_ID] };
    const bare = { id: BARE_ID, type: "model", label: "Zeta", make: "TestClearPos", year: 2003, end: 2010, familyOf: FAM_ID, wp: "TestClearPos Zeta" };
    const g01 = { id: G01_ID, type: "model", label: "Zeta (G01)", make: "TestClearPos", year: 2017, end: null, familyOf: FAM_ID, wp: "TestClearPos Zeta (G01)" };
    const famA = { id: FAM_A, type: "family", label: "Eta", make: "TestClearPos", year: 2000, end: null, generations: [A1] };
    const famB = { id: FAM_B, type: "family", label: "Theta", make: "TestClearPos", year: 2005, end: null, generations: [B1] };
    const a1 = { id: A1, type: "model", label: "Eta (I)", make: "TestClearPos", familyOf: FAM_A, year: 2000, end: null };
    const b1 = { id: B1, type: "model", label: "Theta (I)", make: "TestClearPos", familyOf: FAM_B, year: 2005, end: null };
    DATA.nodes.push(fam, bare, g01, famA, famB, a1, b1);
    DATA.links.push({ source: FAM_ID, target: mk.id, type: "made" }, { source: FAM_A, target: mk.id, type: "made" }, { source: FAM_B, target: mk.id, type: "made" });
    DATA.links.push({ source: FAM_ID, target: BARE_ID, type: "generation" }, { source: FAM_ID, target: G01_ID, type: "generation" }, { source: BARE_ID, target: G01_ID, type: "gensucc" });
    DATA.links.push({ source: FAM_A, target: A1, type: "generation" }, { source: FAM_B, target: B1, type: "generation" });
    // The `note` is load-bearing as of the no-evidence short-circuit in
    // llm_families.js's checkRelation (real user report: "the LLM tried to
    // check a relationship between the Pontiac G5 and the Marcos TSO, even
    // though it knew they weren't related"). A pair with no note, no article
    // text mentioning the other car, and no chassis code found in either one
    // has nothing to resolve a specific generation pair from, so the check
    // now returns "none" without spending a llama.cpp call at all. These
    // synthetic fixtures have no Wikipedia articles to gather evidence from,
    // so without a note they would take that short-circuit and this scenario
    // -- which is about the review UI on a REAL model verdict, not about the
    // evidence gate -- would never reach the model at all.
    DATA.links.push({ source: FAM_A, target: FAM_B, type: "related", note: "Alpha and Beta are described as sister models sharing a platform." });
  }
  const proposal = { hasMultipleGenerations: true, generations: [{ code: "G01", yearStart: 2017, yearEnd: null, designers: [], engineers: [] }] };
  const window = freshWindow({ seed });
  const relKey = [FAM_A, FAM_B].sort().join("|") + "|related";
  window.LLM_FAMILIES = {
    families: {},
    recheck: {
      [FAM_ID]: { status: "applied", checkedAt: new Date().toISOString(), appliedAt: new Date().toISOString(), sourceTitle: "TestClearPos Zeta", proposal, attempts: 1, feedback: [] },
    },
    relations: {
      [relKey]: { famA: FAM_A, famB: FAM_B, relType: "related", status: "confirmed", codeA: "Eta (I)", codeB: "Theta (I)", checkedAt: new Date().toISOString() },
    },
    __serverAvailable: true,
  };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");
  const cw = window.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);

  cw.openDetail(cw.byId.get(FAM_ID));
  check("'applied' message showing before the bulk clear", !!window.document.querySelector(".dt-llmcheck .llm-applied"));
  cw.openDetail(cw.byId.get(FAM_A));
  check("'resolved' relation message showing before the bulk clear", !!window.document.querySelector(".dt-relations .llm-resolved"));

  window.document.getElementById("llmdebugbtn").onclick();
  const clearPositiveBtn = window.document.getElementById("llmdebug-clearpositive");
  check("'Clear all positive messages' button exists in the LLM Debug panel", !!clearPositiveBtn);
  check("button is enabled when positive messages exist", clearPositiveBtn && !clearPositiveBtn.disabled);
  clearPositiveBtn.onclick();

  check("resolved relation message on the currently-open panel clears immediately", !window.document.querySelector(".dt-relations .llm-resolved"));
  cw.openDetail(cw.byId.get(FAM_ID));
  check("applied family message also cleared (dismissal is global, not per-panel)", !window.document.querySelector(".dt-llmcheck .llm-applied"));

  // The underlying persisted data itself must be untouched -- this is a
  // session-local UI dismissal, not "Clear ALL" (which actually deletes).
  check("underlying 'applied' entry itself is untouched (still status applied)", window.LlmFamilies.recheckEntryFor(FAM_ID).status === "applied");
  check("underlying 'confirmed' relation entry itself is untouched", window.LlmFamilies.relationEntryFor(relKey).status === "confirmed");
}

(async () => {
  await scenario1_extractionAndNoneClose();
  scenario2_provisionalAutoApplies();
  scenario3_familyRecheckDebugAndAppliedClose();
  await scenario4_relationNoneAndResolvedClose();
  scenario5_clearAllPositiveMessages();

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
