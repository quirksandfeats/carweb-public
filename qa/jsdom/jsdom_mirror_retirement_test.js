// Verifies a real bug report end-to-end: BMW X3 (corrected via Feature 4's
// nameplate generation-list override) carries a build-time "related"
// connection to BMW X4 that only ever existed at the SPECIFIC-generation
// level (a bare, now-retired "X3" node -> "X4"), mirrored up to the family
// level for the collapsed view. Three things used to go wrong once the bare
// X3 node got retired:
//   1. The fresh, real X3 generation the override minted never got a REAL
//      graph link to the designer credited in its own text field ("drawn by
//      Calvin Luk" showed as text but had no actual connector node) --
//      llm_families.js's applyFamilyOverride only ever folded RETIRED
//      generations' credits up to the family, never wired the SURVIVING/
//      newly-minted ones at all.
//   2. Once X3 was expanded, the coarse X3<->X4 mirror line disappeared
//      entirely -- linkInLayer's mirror-hide trusted the untouched original
//      link to take its place the moment its family was expanded, but that
//      original link's own endpoint (the bare X3 node) was now PERMANENTLY
//      retired, so nothing ever actually took its place. "The connection
//      only sometimes shows in the overview" was this: whichever side you'd
//      previously expanded determined whether the (now-orphaned) mirror hid
//      with nothing to replace it.
//   3. Once X4 also turned out to hide two generations of its own (via
//      cascading discovery) and the specific-generation relation check
//      couldn't confidently match a pair (a real risk once a nameplate has
//      more than one generation and the exact code string has to be echoed
//      back correctly), the box just silently vanished forever with no way
//      to make the specific link happen at all.
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

const FAM_ID = "fam-test-x3m";
const BARE_ID = "m-test-x3m-bare";
const G45_ID = "m-test-x3m-g45";
const X4_ID = "m-test-x4m";

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

const X4_WIKITEXT = "{{Infobox automobile\n| name = TestBMW X4m\n}}\nThe first generation F26 was launched in 2014. " +
  "The second generation G02 followed in 2018 with updated styling.";

let relationCallCount = 0;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": X4_WIKITEXT } } }) });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    const msgText = JSON.stringify(body.messages);
    if (msgText.includes("You extract car production-generation data")) {
      // Only X4's cascade check ever actually round-trips through llama.cpp in
      // this test (X3's own Feature 4 override is seeded pre-decided below,
      // same shortcut jsdom_family_recheck_test.js already uses).
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: true,
          generations: [
            { code: "F26", yearStart: 2014, yearEnd: 2018, designers: [], engineers: [], sharedPlatform: null },
            { code: "G02", yearStart: 2018, yearEnd: null, designers: [], engineers: [], sharedPlatform: null },
          ],
        }) } }] }),
      });
    }
    // The Calvin Luk designer credit this test mints (see "Fix A" below)
    // now also kicks off a background year/bio fact-backfill (see
    // llm_families.js's scheduleFactBackfill) -- a real extra /api/llm/chat
    // call this test predates. Answered here as an honest "couldn't find
    // anything" (low confidence / no article) so it's a harmless no-op and,
    // critically, so it's never mistaken for the relation-disambiguation
    // call below by falling through to that branch's own counter.
    if (msgText.includes("basic biographical facts")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ born: null, died: null, country: null, confidence: "low" }) } }] }),
      });
    }
    // Grounded tier: this test's Wikipedia mock returns X4's wikitext for
    // ANY title (it doesn't branch on the requested page), so a lookup for
    // "Calvin Luk" would otherwise get real (if irrelevant) text back and
    // reach this far too -- answered honestly as "nothing about this person
    // in that text" so it falls through to the knowledge-recall tier above,
    // same as the real app would for an unrelated article.
    if (msgText.includes("birth year, death year")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ born: null, died: null, country: null }) } }] }),
      });
    }
    // Relation-disambiguation call. First attempt deliberately echoes back
    // codes that don't exist in either side's real generation list (both
    // X3 and X4 now have 2 real generations each, so neither auto-accepts
    // as a single option) -- exercising the "none" -> retry path. Second
    // attempt (after the user retries) echoes back the actual codes.
    relationCallCount++;
    if (relationCallCount === 1) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          resolved: true, codeA: "nonexistent-code-a", codeB: "nonexistent-code-b", reason: "bad guess",
        }) } }] }),
      });
    }
    // `reason` deliberately reads as genuine article evidence rather than a
    // bare date-overlap guess -- see llm_families.js's reasonLooksDateOnly,
    // which now declines to trust a resolved:true verdict backed by
    // nothing but "the years line up" when there's no other evidence.
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        resolved: true, codeA: "X3m G01/F97", codeB: "X4m G02", reason: "the X4m article explicitly names this as its platform donor",
      }) } }] }),
    });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

// ---------- seed: X3 family with a bogus bare generation + a real G45,
// build-time-mirrored to a still-plain X4 exactly like the real BMW data ----------
const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestBMW");
if (!makeNode) { makeNode = { id: "mk-testbmwm", type: "make", label: "TestBMW", year: 1916 }; DATA.nodes.push(makeNode); }
const famX3 = { id: FAM_ID, type: "family", label: "X3m", make: "TestBMW", year: 2003, end: null,
  designers: [], engineers: [], generations: [BARE_ID, G45_ID] };
const bareGen = { id: BARE_ID, type: "model", label: "X3m", make: "TestBMW", year: 2003, end: 2024,
  familyOf: FAM_ID, wp: "TestBMW X3m", designers: [], engineers: [] };
const g45Gen = { id: G45_ID, type: "model", label: "X3m (G45)", make: "TestBMW", year: 2024, end: null,
  familyOf: FAM_ID, wp: "TestBMW X3m (G45)", designers: [], engineers: [] };
const x4Plain = { id: X4_ID, type: "model", label: "X4m", make: "TestBMW", year: 2014, end: null, wp: "TestBMW X4m" };
DATA.nodes.push(famX3, bareGen, g45Gen, x4Plain);
DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: FAM_ID, target: BARE_ID, type: "generation" });
DATA.links.push({ source: FAM_ID, target: G45_ID, type: "generation" });
DATA.links.push({ source: BARE_ID, target: G45_ID, type: "gensucc" });
DATA.links.push({ source: X4_ID, target: makeNode.id, type: "made" });
// The exact build-time shape found in the real dataset: the "real",
// specific-generation link, PLUS its family-level mirror stand-in.
// The `note` on the mirror is load-bearing as of the no-evidence
// short-circuit in llm_families.js's checkRelation (real user report: "the
// LLM tried to check a relationship between the Pontiac G5 and the Marcos
// TSO, even though it knew they weren't related"). app.js's
// unresolvedFamilyRelations reads it straight off this link as the check's
// `note`; without one, and with no real Wikipedia articles behind these
// synthetic fixtures to gather evidence from, the FIRST relation check would
// now short-circuit to "none" without ever calling the model -- which would
// silently shift the stub's relationCallCount by one and make the retry
// below receive the "bad guess" response intended for the first attempt.
DATA.links.push({ source: BARE_ID, target: X4_ID, type: "related" });
DATA.links.push({ source: FAM_ID, target: X4_ID, type: "related", mirror: true, mirrorSourceFam: FAM_ID,
  note: "The X4m is described as sharing its platform with the X3m." });

// Feature 4's override, pre-decided (same shortcut the existing recheck test
// uses) -- a fresh Wikipedia read finds E83 was actually a typo-free G45
// (kept, matches the old node) plus a real G01/F97 generation the bare node
// was standing in for, complete with a designer credit.
const freshProposal = {
  hasMultipleGenerations: true,
  generations: [
    { code: "G45", yearStart: 2024, yearEnd: null, designers: [], engineers: [] },
    { code: "G01/F97", yearStart: 2017, yearEnd: 2024, designers: ["Test X3 Designer"], engineers: [] },
  ],
};
window.LLM_FAMILIES = {
  families: {}, relations: {},
  recheck: {
    [FAM_ID]: {
      status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "TestBMW X3m",
      proposal: freshProposal, discrepancy: "an existing generation here is really just the bare nameplate itself",
      attempts: 1, feedback: [],
    },
  },
  __serverAvailable: true,
};
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setLlmCheck(true);
const x3 = cw.byId.get(FAM_ID);
const x4 = cw.byId.get(X4_ID);
const mirrorLink = cw.links.find(l => l.type === "related" && l.mirror &&
  ((l.sn === x3 && l.tn === x4) || (l.sn === x4 && l.tn === x3)));
check("precondition: mirror link exists", !!mirrorLink);

(async () => {
  // ---------- Fix A: accept the Feature 4 override, verify real designer link ----------
  cw.openDetail(x3);
  const yesBtn = window.document.querySelector(".dt-llmcheck .llm-yes");
  check("Feature 4 discrepancy Accept button rendered", !!yesBtn);
  yesBtn.onclick();

  const bare = cw.byId.get(BARE_ID);
  check("bogus bare X3 generation retired", bare.retired === true);
  const g01f97 = x3.generations.map(id => cw.byId.get(id)).find(g => g.label.includes("G01/F97"));
  check("real G01/F97 generation minted", !!g01f97, x3.generations);
  check("its designer text field is set (what the detail panel reads for 'drawn by')",
    g01f97 && g01f97.designers && g01f97.designers.includes("Test X3 Designer"));

  const designerLink = cw.links.find(l => l.type === "designed" && l.sn === g01f97 && l.tn && l.tn.label === "Test X3 Designer");
  check("Fix A: G01/F97 has a REAL graph link to its designer, not just text", !!designerLink);
  const famDesignerLink = cw.links.find(l => l.type === "designed" && l.sn === x3 && l.tn && l.tn.label === "Test X3 Designer");
  check("Fix A: the designer credit is also mirrored up to the family node itself", !!famDesignerLink);

  // ---------- Fix C: mirror survives once its only replacement is permanently retired ----------
  cw.expandFamily(FAM_ID);
  check("Fix C: mirror link STILL shows once X3 is expanded (its only candidate, the bare node's link, is retired for good)",
    cw.linkInLayer(mirrorLink));

  // ---------- cascade-discover X4 also hides two generations (auto-applied,
  // no approval needed -- real user request: "if a car is creating a
  // nameplate for the first time... you do not need my approval... simply
  // do so without my request", which applies here too since X4 is a plain
  // model becoming a nameplate for the very first time). Applying and
  // kicking off the follow-on relation-disambiguation check both happen in
  // the same async chain now, so one longer wait covers both. ----------
  await sleep(120);
  check("X4 became a real family automatically -- no cascade approval needed", x4.type === "family", x4.type);
  check("no cascade Yes/No proposal ever shown -- it applied itself immediately",
    !window.document.querySelector(".dt-relations .llm-cascade-yes"));

  // ---------- relation check resolves to "none" first (bad LLM guess) ----------
  const noneStatus = window.document.querySelector(".dt-relations .llm-status");
  check("relation check couldn't confidently match a pair -- shown as 'none' with a retry option, not stuck on 'checking...' forever",
    !!noneStatus && noneStatus.textContent.includes("couldn't confidently match"), noneStatus && noneStatus.textContent);
  const retryBtn = window.document.querySelector(".dt-relations .llm-rel-retry");
  const reasonInput = window.document.querySelector(".dt-relations .llm-reason");
  check("retry row is offered instead of the box just vanishing", !!retryBtn && !!reasonInput);

  cw.expandFamily(X4_ID);
  check("Fix C still holds with both sides expanded and no resolution yet (mirror keeps showing)", cw.linkInLayer(mirrorLink));

  // ---------- retry succeeds ----------
  reasonInput.value = "match by production years";
  retryBtn.onclick();
  await sleep(60);
  const relLabel = window.document.querySelector(".dt-relations .llm-label");
  check("retry produced a genuine generation<->generation match", !!relLabel && relLabel.textContent.includes("related connection"),
    relLabel && relLabel.textContent);
  const relYes = window.document.querySelector(".dt-relations .llm-rel-yes");
  check("relation Yes button rendered after retry", !!relYes);
  relYes.onclick();

  const g02 = x4.generations.map(id => cw.byId.get(id)).find(g => g.label.includes("G02"));
  const resolvedLink = cw.links.find(l => l.type === "related" && l.llmResolved &&
    ((l.sn === g01f97 && l.tn === g02) || (l.sn === g02 && l.tn === g01f97)));
  check("Make sure to make this link: genuine X3 (G01/F97) <-> X4 (G02) generation-level link now exists", !!resolvedLink);
  check("the resolved link is actually drawable (both endpoints in view)",
    !!resolvedLink && cw.linkInLayer(resolvedLink) && cw.nodeInLayer(resolvedLink.sn) && cw.nodeInLayer(resolvedLink.tn));

  check("Fix C: the coarse mirror now correctly HIDES -- a real replacement is finally visible",
    !cw.linkInLayer(mirrorLink));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
