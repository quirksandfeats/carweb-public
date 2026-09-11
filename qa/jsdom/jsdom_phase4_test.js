// Covers the four Phase 4 fixes from a single real bug report session:
//   1. Lenient relation-code matching -- a small local model reliably drops
//      the nameplate-name prefix off an offered generation code ("Gamma A2"
//      echoed back as just "A2"); llm_families.js's findGenByCode now
//      accepts that instead of hard-failing to "none" (real report: BMW
//      X1/X2's own debug JSON showed resolved:true with codes the app still
//      reported as "couldn't confidently match").
//   2. Three-tier relation fallback -- generation<->generation is best; if
//      only ONE side resolves, pin that generation straight to the OTHER
//      nameplate as a whole rather than discarding a half-confident answer
//      entirely (explicit user-specified order: generation->generation,
//      then generation->nameplate, then nameplate->nameplate/nothing-new).
//   3. Bidirectional single-generation shared-platform discovery -- a
//      shared-platform mention stated on only ONE of two nameplates' own
//      Wikipedia articles (real report: Infiniti QX30's article mentions
//      the Mercedes A-Class platform share, the A-Class's own article never
//      mentions the QX30 back) still wires the connection in for both,
//      discovered from whichever side happens to get checked.
//   4. Generation end-year backfill -- an open-ended early generation
//      ("1968-") sitting right before a later one that starts in 1972 is
//      backfilled to end in 1972; only the LAST generation of a nameplate
//      (or a nameplate with just one generation total) may stay open-ended.
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

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

// ---------- ids ----------
const FAM_G_ID = "fam-test-ph4-gamma", G1_ID = "m-test-ph4-gamma-a1", G2_ID = "m-test-ph4-gamma-a2";
const FAM_D_ID = "fam-test-ph4-delta", D1_ID = "m-test-ph4-delta-b1", D2_ID = "m-test-ph4-delta-b2";
const FAM_E_ID = "fam-test-ph4-epsilon", E1_ID = "m-test-ph4-epsilon-e1", E2_ID = "m-test-ph4-epsilon-e2";
const FAM_Z_ID = "fam-test-ph4-zeta", Z1_ID = "m-test-ph4-zeta-z1", Z2_ID = "m-test-ph4-zeta-z2";
const Q_ID = "m-test-ph4-qx30ish", M_ID = "m-test-ph4-aclassish";
const FAM_Y_ID = "fam-test-ph4-yoyo", Y1_ID = "m-test-ph4-yoyo-y1", Y2_ID = "m-test-ph4-yoyo-y2", Y3_ID = "m-test-ph4-yoyo-y3";
const FAM_SOLO_ID = "fam-test-ph4-solo", S1_ID = "m-test-ph4-solo-s1";
// scenario 5: real bug report -- checking Mercedes A-Class vs Infiniti QX30
// failed to identify WHICH A-Class generation the QX30 shares a platform
// with, even though the Infiniti article's own "related" field named the
// exact chassis code right next to the nameplate name: "Related: Infiniti
// Q30, Mercedes-Benz A-Class (W176), Mercedes-Benz GLA (X156)".
const Q2_ID = "m-test-ph4-qx30ish2";
const FAM_EMC_ID = "fam-test-ph4-aclassish2", EMC1_ID = "m-test-ph4-aclassish2-w176", EMC2_ID = "m-test-ph4-aclassish2-w177";

const QX30_WIKITEXT = "{{Infobox automobile\n| name = TestInfiniti QX30ish\n| related = TestMercedes A-Classish\n}}\n" +
  "The TestInfiniti QX30ish shares its platform with the TestMercedes A-Classish, using the same MFA platform architecture.";
const QX30_WIKITEXT2 = "{{Infobox automobile\n| name = TestInfiniti QX30ish2\n| related = TestMercedes A-Classish2 (W176), TestMercedes GLA-ish (X156)\n}}\n" +
  "The TestInfiniti QX30ish2 shares its platform with the TestMercedes A-Classish2 (W176), using the same MFA2 platform architecture.";

let ollamaGenCalls = 0;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    const wt = u.includes("QX30ish2") ? QX30_WIKITEXT2 : QX30_WIKITEXT;
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    const msgText = JSON.stringify(body.messages);
    if (msgText.includes("QX30ish2")) {
      // Scenario 5: shared-platform text includes the explicit chassis code
      // right next to the nameplate name, exactly like the real Infiniti
      // article's "related" field -- must appear verbatim in the supplied
      // wikitext (QX30_WIKITEXT2 above) to pass the hallucination guard.
      ollamaGenCalls++;
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: false,
          generations: [
            { code: "TestInfiniti QX30ish2", yearStart: 2016, yearEnd: 2019, designers: [], engineers: [], sharedPlatform: "TestMercedes A-Classish2 (W176)" },
          ],
        }) } }] }),
      });
    }
    if (msgText.includes("You extract car production-generation data")) {
      ollamaGenCalls++;
      // Only the QX30ish plain-model generation check ever round-trips
      // through here in this test -- single generation, with a
      // shared-platform mention (scenario 3).
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: false,
          generations: [
            { code: "TestInfiniti QX30ish", yearStart: 2016, yearEnd: 2019, designers: [], engineers: [], sharedPlatform: "TestMercedes A-Classish" },
          ],
        }) } }] }),
      });
    }
    // Relation-disambiguation calls (scenarios 1 & 2) -- branch by which
    // synthetic pair is actually being asked about.
    if (msgText.includes("Gamma") && msgText.includes("Delta")) {
      // Scenario 1: lenient code matching -- both codes echoed back WITHOUT
      // their nameplate-name prefix, exactly the real BMW X1/X2 bug report.
      // `reason` deliberately reads as genuine article evidence rather than
      // a bare date-overlap guess -- see llm_families.js's
      // reasonLooksDateOnly, which now declines to trust a resolved:true
      // verdict backed by nothing but "the years line up" when (as here)
      // there's no deterministic evidence either.
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          resolved: true, codeA: "A2", codeB: "B2", reason: "the Delta article explicitly names Gamma A2 as its platform donor",
        }) } }] }),
      });
    }
    if (msgText.includes("Epsilon") && msgText.includes("Zeta")) {
      // Scenario 2: only ONE side resolves to a real code; the other is a
      // genuine non-match -- three-tier fallback should still make a
      // generation<->nameplate connection instead of nothing.
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          resolved: true, codeA: "E2", codeB: "totally-unmatched-code", reason: "epsilon confident, zeta unclear",
        }) } }] }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: false, codeA: null, codeB: null, reason: "n/a" }) } }] }) });
  }
  // Wikipedia REST summary endpoint (wiki() in app.js) -- used by scenario 4-ish
  // db wp backfill check below; harmless default elsewhere.
  if (u.startsWith("https://en.wikipedia.org/api/rest_v1/page/summary/")) {
    return Promise.resolve({ ok: true, json: async () => ({
      extract: "A stub Wikipedia summary paragraph for testing purposes only. It has two sentences.",
      thumbnail: { source: "https://example.test/thumb.jpg" },
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Stub" } },
    }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMk-ph4");
if (!makeNode) { makeNode = { id: "mk-test-ph4", type: "make", label: "TestMk-ph4", year: 1950 }; DATA.nodes.push(makeNode); }

// ---------- scenario 1 & 2 seed: two family pairs with real generations already in place ----------
const famG = { id: FAM_G_ID, type: "family", label: "Gamma", make: "TestMk-ph4", year: 2000, end: null, designers: [], engineers: [], generations: [G1_ID, G2_ID] };
const g1 = { id: G1_ID, type: "model", label: "Gamma A1", make: "TestMk-ph4", year: 2000, end: 2010, familyOf: FAM_G_ID, designers: [], engineers: [] };
const g2 = { id: G2_ID, type: "model", label: "Gamma A2", make: "TestMk-ph4", year: 2010, end: null, familyOf: FAM_G_ID, designers: [], engineers: [] };
const famD = { id: FAM_D_ID, type: "family", label: "Delta", make: "TestMk-ph4", year: 2000, end: null, designers: [], engineers: [], generations: [D1_ID, D2_ID] };
const d1 = { id: D1_ID, type: "model", label: "Delta B1", make: "TestMk-ph4", year: 2000, end: 2010, familyOf: FAM_D_ID, designers: [], engineers: [] };
const d2 = { id: D2_ID, type: "model", label: "Delta B2", make: "TestMk-ph4", year: 2010, end: null, familyOf: FAM_D_ID, designers: [], engineers: [] };

const famE = { id: FAM_E_ID, type: "family", label: "Epsilon", make: "TestMk-ph4", year: 2000, end: null, designers: [], engineers: [], generations: [E1_ID, E2_ID] };
const e1 = { id: E1_ID, type: "model", label: "Epsilon E1", make: "TestMk-ph4", year: 2000, end: 2010, familyOf: FAM_E_ID, designers: [], engineers: [] };
const e2 = { id: E2_ID, type: "model", label: "Epsilon E2", make: "TestMk-ph4", year: 2010, end: null, familyOf: FAM_E_ID, designers: [], engineers: [] };
const famZ = { id: FAM_Z_ID, type: "family", label: "Zeta", make: "TestMk-ph4", year: 2000, end: null, designers: [], engineers: [], generations: [Z1_ID, Z2_ID] };
const z1 = { id: Z1_ID, type: "model", label: "Zeta Z1", make: "TestMk-ph4", year: 2000, end: 2010, familyOf: FAM_Z_ID, designers: [], engineers: [] };
const z2 = { id: Z2_ID, type: "model", label: "Zeta Z2", make: "TestMk-ph4", year: 2010, end: null, familyOf: FAM_Z_ID, designers: [], engineers: [] };

DATA.nodes.push(famG, g1, g2, famD, d1, d2, famE, e1, e2, famZ, z1, z2);
[FAM_G_ID, FAM_D_ID, FAM_E_ID, FAM_Z_ID].forEach(id => DATA.links.push({ source: id, target: makeNode.id, type: "made" }));
DATA.links.push({ source: FAM_G_ID, target: G1_ID, type: "generation" }, { source: FAM_G_ID, target: G2_ID, type: "generation" }, { source: G1_ID, target: G2_ID, type: "gensucc" });
DATA.links.push({ source: FAM_D_ID, target: D1_ID, type: "generation" }, { source: FAM_D_ID, target: D2_ID, type: "generation" }, { source: D1_ID, target: D2_ID, type: "gensucc" });
DATA.links.push({ source: FAM_E_ID, target: E1_ID, type: "generation" }, { source: FAM_E_ID, target: E2_ID, type: "generation" }, { source: E1_ID, target: E2_ID, type: "gensucc" });
DATA.links.push({ source: FAM_Z_ID, target: Z1_ID, type: "generation" }, { source: FAM_Z_ID, target: Z2_ID, type: "generation" }, { source: Z1_ID, target: Z2_ID, type: "gensucc" });
// Coarse, undisambiguated nameplate<->nameplate facts (mimics build-time data).
// The `note` on each is load-bearing as of the no-evidence short-circuit in
// llm_families.js's checkRelation (real user report: "the LLM tried to check
// a relationship between the Pontiac G5 and the Marcos TSO, even though it
// knew they weren't related"): a pair with no note, no article text
// mentioning the other car, and no chassis code found in either one now
// resolves to "none" without spending a llama.cpp call at all. These
// synthetic nameplates have no real Wikipedia articles behind them, so
// without a note they'd take that short-circuit and never reach the
// code-matching leniency these scenarios actually exist to test.
DATA.links.push({ source: FAM_G_ID, target: FAM_D_ID, type: "platform", note: "Gammaish and Deltaish are built on the same platform." });
DATA.links.push({ source: FAM_E_ID, target: FAM_Z_ID, type: "platform", note: "Epsilonish and Zetaish are built on the same platform." });

// ---------- scenario 3 seed: two plain, never-split models ----------
const modelQ = { id: Q_ID, type: "model", label: "QX30ish", make: "TestInfiniti", year: 2016, end: 2019, wp: "TestInfiniti QX30ish" };
const modelM = { id: M_ID, type: "model", label: "A-Classish", make: "TestMercedes", year: 2013, end: null, wp: "TestMercedes A-Classish" };
DATA.nodes.push(modelQ, modelM);
DATA.links.push({ source: Q_ID, target: makeNode.id, type: "made" }, { source: M_ID, target: makeNode.id, type: "made" });

// ---------- scenario 5 seed: explicit generation code in a shared-platform mention ----------
const modelQ2 = { id: Q2_ID, type: "model", label: "QX30ish2", make: "TestInfiniti", year: 2016, end: 2019, wp: "TestInfiniti QX30ish2" };
const famEMC = { id: FAM_EMC_ID, type: "family", label: "A-Classish2", make: "TestMercedes", year: 2012, end: null, designers: [], engineers: [], generations: [EMC1_ID, EMC2_ID] };
// Both generations' production years overlap modelQ2's own 2016-2019 range,
// so a year-overlap guess alone is genuinely ambiguous between them (cands
// would be length 2, not 1) -- proving the explicit "(W176)" code is really
// what picks EMC1 specifically, not a lucky single-candidate year overlap.
const emc1 = { id: EMC1_ID, type: "model", label: "A-Classish2 W176", make: "TestMercedes", year: 2012, end: 2018, familyOf: FAM_EMC_ID, designers: [], engineers: [] };
const emc2 = { id: EMC2_ID, type: "model", label: "A-Classish2 W177", make: "TestMercedes", year: 2018, end: null, familyOf: FAM_EMC_ID, designers: [], engineers: [] };
DATA.nodes.push(modelQ2, famEMC, emc1, emc2);
DATA.links.push({ source: Q2_ID, target: makeNode.id, type: "made" }, { source: FAM_EMC_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: FAM_EMC_ID, target: EMC1_ID, type: "generation" }, { source: FAM_EMC_ID, target: EMC2_ID, type: "generation" }, { source: EMC1_ID, target: EMC2_ID, type: "gensucc" });

// ---------- scenario 4 seed: generation end-year backfill ----------
const famY = { id: FAM_Y_ID, type: "family", label: "Yoyo", make: "TestMk-ph4", year: 1968, end: null, designers: [], engineers: [], generations: [Y1_ID, Y2_ID, Y3_ID] };
const y1 = { id: Y1_ID, type: "model", label: "Yoyo I", make: "TestMk-ph4", year: 1968, end: null, familyOf: FAM_Y_ID, designers: [], engineers: [] }; // open-ended, NOT the last gen -> should get bounded
const y2 = { id: Y2_ID, type: "model", label: "Yoyo II", make: "TestMk-ph4", year: 1972, end: 1980, familyOf: FAM_Y_ID, designers: [], engineers: [] }; // already bounded -> untouched
const y3 = { id: Y3_ID, type: "model", label: "Yoyo III", make: "TestMk-ph4", year: 1980, end: null, familyOf: FAM_Y_ID, designers: [], engineers: [] }; // open-ended, IS the last gen -> stays open
const famSolo = { id: FAM_SOLO_ID, type: "family", label: "Solo", make: "TestMk-ph4", year: 1990, end: null, designers: [], engineers: [], generations: [S1_ID] };
const s1 = { id: S1_ID, type: "model", label: "Solo I", make: "TestMk-ph4", year: 1990, end: null, familyOf: FAM_SOLO_ID, designers: [], engineers: [] }; // only generation -> nothing to infer from, stays open
DATA.nodes.push(famY, y1, y2, y3, famSolo, s1);
DATA.links.push({ source: FAM_Y_ID, target: makeNode.id, type: "made" }, { source: FAM_SOLO_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: FAM_Y_ID, target: Y1_ID, type: "generation" }, { source: FAM_Y_ID, target: Y2_ID, type: "generation" }, { source: FAM_Y_ID, target: Y3_ID, type: "generation" });
DATA.links.push({ source: Y1_ID, target: Y2_ID, type: "gensucc" }, { source: Y2_ID, target: Y3_ID, type: "gensucc" });
DATA.links.push({ source: FAM_SOLO_ID, target: S1_ID, type: "generation" });

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
  loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
cw.setLlmCheck(true);

// ================= scenario 4: generation end-year backfill (pure boot-time data cleanup, no async) =================
console.log("\n--- scenario 4: generation end-year backfill ---");
const bY1 = cw.byId.get(Y1_ID), bY2 = cw.byId.get(Y2_ID), bY3 = cw.byId.get(Y3_ID), bS1 = cw.byId.get(S1_ID);
check("open-ended early generation backfilled to the next generation's start year", bY1.end === 1972, bY1.end);
check("already-bounded middle generation left untouched", bY2.end === 1980, bY2.end);
check("the LAST generation of a multi-generation nameplate stays open-ended", bY3.end == null, bY3.end);
check("a nameplate with only ONE generation total stays open-ended (nothing to infer a boundary from)", bS1.end == null, bS1.end);

(async () => {
  // ================= scenario 1: lenient code matching -> full generation<->generation match =================
  console.log("\n--- scenario 1: lenient relation-code matching (real BMW X1/X2 bug report) ---");
  const famGamma = cw.byId.get(FAM_G_ID), famDelta = cw.byId.get(FAM_D_ID);
  cw.openDetail(famGamma);
  await sleep(60);
  // The lenient code matching still has to work -- that's what this scenario
  // is about. What changed is the OUTCOME: a reason citing the article now
  // auto-confirms, so the pair renders as a resolved line rather than a
  // provisional one awaiting a click.
  const s1Line = window.document.querySelector(".dt-relations .llm-resolved-text") ||
                 window.document.querySelector(".dt-relations .llm-label");
  check("the match is rendered despite the LLM dropping both nameplate-name prefixes",
    !!s1Line, s1Line && s1Line.textContent);
  const s1Key = [FAM_G_ID, FAM_D_ID].sort().join("|") + "|platform";
  const s1Entry = window.LlmFamilies.relationEntryFor(s1Key);
  check("resolved to the full 'generation' tier (both sides matched leniently)", s1Entry && s1Entry.matchLevel === "generation", s1Entry && s1Entry.matchLevel);
  check("codeA correctly identified as Gamma A2 despite being echoed back as just 'A2'", s1Entry && s1Entry.genIdA === G2_ID, s1Entry && s1Entry.genIdA);
  check("codeB correctly identified as Delta B2 despite being echoed back as just 'B2'", s1Entry && s1Entry.genIdB === D2_ID, s1Entry && s1Entry.genIdB);

  // This fixture's reason is "the Delta article explicitly names Gamma A2 as
  // its platform donor" -- article attribution plus a code out of the real
  // supplied list, which is exactly the case Andy asked to stop being put in
  // front of him ("this should be sufficient information for the program to
  // automatically approve this relationship. I shouldn't have to approve it
  // myself"). It now auto-confirms, so there is no Yes button to click and the
  // link is already wired in.
  check("the citation-backed match auto-confirms instead of asking",
    s1Entry && s1Entry.status === "confirmed", s1Entry && s1Entry.status);
  check("...with no Yes button left to click",
    !window.document.querySelector(".dt-relations .llm-rel-yes"));
  const s1ResolvedLink = cw.links.find(l => l.type === "platform" && l.llmResolved &&
    ((l.sn === g2 && l.tn === d2) || (l.sn === d2 && l.tn === g2)));
  check("genuine Gamma(A2) <-> Delta(B2) generation-level link created", !!s1ResolvedLink);
  cw.expandFamily(FAM_G_ID); cw.expandFamily(FAM_D_ID); // generation nodes only show once their family is expanded
  check("the resolved link is actually drawable", !!s1ResolvedLink && cw.linkInLayer(s1ResolvedLink) &&
    cw.nodeInLayer(s1ResolvedLink.sn) && cw.nodeInLayer(s1ResolvedLink.tn));

  // ================= scenario 2: three-tier fallback -> generation<->nameplate =================
  console.log("\n--- scenario 2: three-tier fallback (one side resolves, other doesn't -> generation<->nameplate) ---");
  const famEpsilon = cw.byId.get(FAM_E_ID), famZeta = cw.byId.get(FAM_Z_ID);
  // Real behavior change: LLM Check auto-disengages once a check is kicked
  // off (see app.js's disengageLlmCheckFor) -- scenario 1 above already
  // consumed the single arming from the top of this file for famGamma's own
  // task. famEpsilon is a genuinely different nameplate, so it needs its
  // own explicit re-arm, same as a real user re-clicking the button.
  cw.setLlmCheck(true);
  cw.openDetail(famEpsilon);
  await sleep(60);
  const s2Label = window.document.querySelector(".dt-relations .llm-label");
  check("provisional match rendered even though only ONE side resolved", !!s2Label, s2Label && s2Label.textContent);
  const s2Key = [FAM_E_ID, FAM_Z_ID].sort().join("|") + "|platform";
  const s2Entry = window.LlmFamilies.relationEntryFor(s2Key);
  check("matchLevel is 'nameplate' (partial resolution), not 'generation' or discarded to 'none'",
    s2Entry && s2Entry.matchLevel === "nameplate", s2Entry && s2Entry.matchLevel);
  check("the confidently-resolved side (Epsilon E2) is pinned to its real generation", s2Entry && s2Entry.genIdA === E2_ID, s2Entry && s2Entry.genIdA);
  check("the unresolved side (Zeta) is represented by the whole nameplate's own id, not a guessed generation",
    s2Entry && s2Entry.genIdB === FAM_Z_ID, s2Entry && s2Entry.genIdB);

  const s2YesBtn = window.document.querySelector(".dt-relations .llm-rel-yes");
  check("Yes button rendered for the partial (generation<->nameplate) match", !!s2YesBtn);
  s2YesBtn.onclick();
  const s2ResolvedLink = cw.links.find(l => l.type === "platform" && l.llmResolved &&
    ((l.sn === e2 && l.tn === famZ) || (l.sn === famZ && l.tn === e2)));
  check("Make sure to make this link: Epsilon(E2) <-> whole Zeta nameplate link created (better than nothing)", !!s2ResolvedLink);
  cw.expandFamily(FAM_E_ID); // E2 generation node only shows once Epsilon is expanded; Zeta stays collapsed (family node always visible)
  check("this generation<->nameplate link is actually drawable", !!s2ResolvedLink && cw.linkInLayer(s2ResolvedLink) &&
    cw.nodeInLayer(s2ResolvedLink.sn) && cw.nodeInLayer(s2ResolvedLink.tn));

  // ================= scenario 3: bidirectional single-generation shared-platform discovery =================
  console.log("\n--- scenario 3: bidirectional single-gen shared-platform discovery (Infiniti QX30 / Mercedes A-Class report) ---");
  cw.setLlmCheck(true); // re-arm for this genuinely new car -- see scenario 2's own comment on why
  cw.openDetail(modelQ); // ONLY the QX30ish side is ever checked -- the A-Classish side is never opened at all
  await sleep(60);
  const qEntry = window.LlmFamilies.entryFor(Q_ID);
  check("QX30ish generation check completed as 'none' (single generation, no split)", qEntry && qEntry.status === "none", qEntry && qEntry.status);
  const platformLink = cw.links.find(l => l.type === "platform" && l.llmResolved &&
    ((l.sn === modelQ && l.tn === modelM) || (l.sn === modelM && l.tn === modelQ)));
  check("If it appears in at least one article, it should make the connection for both: QX30ish <-> A-Classish link created from checking ONLY the QX30ish side",
    !!platformLink);
  check("the shared-platform link is actually drawable without ever opening the A-Classish side",
    !!platformLink && cw.linkInLayer(platformLink) && cw.nodeInLayer(platformLink.sn) && cw.nodeInLayer(platformLink.tn));

  // ================= scenario 5: explicit generation code in a shared-platform mention =================
  console.log("\n--- scenario 5: explicit chassis code next to the nameplate mention (real Infiniti QX30 / Mercedes A-Class (W176) report) ---");
  cw.setLlmCheck(true); // re-arm for this genuinely new car -- see scenario 2's own comment on why
  cw.openDetail(modelQ2);
  await sleep(60);
  const q2Entry = window.LlmFamilies.entryFor(Q2_ID);
  check("QX30ish2 generation check completed as 'none' (single generation)", q2Entry && q2Entry.status === "none", q2Entry && q2Entry.status);
  // Real behavior change (task #106, multi-generation-pair support): keyed
  // by the two specific generation ids actually involved (Q2's own single
  // generation and the real EMC1 the explicit code named), not the coarser
  // whole-family id -- see llm_families.js's resolveOnePlatformMention.
  const s5Key = [Q2_ID, EMC1_ID].sort().join("|") + "|platform";
  const s5Rel = window.LlmFamilies.relationEntryFor(s5Key);
  check("relation auto-confirmed with no review step (explicit code is trustworthy enough)", s5Rel && s5Rel.status === "confirmed", s5Rel && s5Rel.status);
  check("resolved to the SPECIFIC generation the code named (W176 = EMC1), not a year-overlap guess between two candidates",
    s5Rel && s5Rel.genIdB === EMC1_ID, s5Rel && s5Rel.genIdB);
  check("did NOT pick the other, equally year-plausible generation (W177 = EMC2)", s5Rel && s5Rel.genIdB !== EMC2_ID, s5Rel && s5Rel.genIdB);
  const s5Link = cw.links.find(l => l.type === "platform" && l.llmResolved &&
    ((l.sn === modelQ2 && l.tn === emc1) || (l.sn === emc1 && l.tn === modelQ2)));
  check("genuine QX30ish2 <-> A-Classish2(W176) link created live, with no Yes-click needed", !!s5Link);
  cw.expandFamily(FAM_EMC_ID);
  check("the resolved link is actually drawable", !!s5Link && cw.linkInLayer(s5Link) && cw.nodeInLayer(s5Link.sn) && cw.nodeInLayer(s5Link.tn));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
