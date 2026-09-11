// Two real bug reports about the interactive relation-check flow
// (checkRelation / previewRelationResult), both diagnosed against the ACTUAL
// live Wikipedia articles (Infiniti Q30, Mercedes-Benz A-Class, Mercedes-
// Benz Vaneo), not synthetic guesses:
//
// 1. "A-Class W168 <-> Vaneo" resolved correctly (Vaneo's own infobox
//    'Related' field really does say "Mercedes-Benz A-Class (W168)"
//    verbatim), but the displayed reason also parroted the small model's
//    own SEPARATE, WRONG verdict ("...as it lists its production years
//    which align with the given timeframe") right alongside the real
//    reason, making a genuinely correct evidence-based match look like it
//    might have been a date-overlap guess. Now the LLM's own reasoning is
//    only echoed when it actually agrees and isn't itself a bare
//    date-alignment claim.
// 2. "A-Class <-> Q30" failed to find the Q30 infobox's own explicit
//    "Mercedes-Benz A-Class (W176)" mention. Root cause, confirmed against
//    real Wikipedia markup conventions: a piped wikilink's chassis-coded
//    TARGET (the real page title) and its plain DISPLAY text can differ --
//    e.g. [[Mercedes-Benz A-Class (W176)|Mercedes-Benz A-Class]] -- and the
//    old wikilink stripping always kept the display half, silently
//    deleting a code that only lived in the target.
//
// Also covers the defense-in-depth fix: even with zero deterministic
// evidence, a small model saying resolved:true on nothing but "the
// production years line up" is no longer trusted (the system prompt
// already forbade this, but a small local model doesn't reliably follow
// prompt-only rules) -- while a genuine LLM-only resolution backed by a
// real "the article explicitly states..." reason still works exactly as
// before.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

function freshWindow(fetchImpl) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.fetch = fetchImpl;
  global.window = window; global.document = window.document;
  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  window.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return window;
}

function genInfo(id, make, label, wp, generations) {
  return { id, make, label, wp, generations };
}

(async () => {
  // ---------- scenario 1: Vaneo-shaped -- evidence resolves it, LLM's own
  // date-overlap tangent must not be shown as if it were the reason ----------
  console.log("--- scenario 1: evidence-resolved match, LLM's own reasoning is a date-overlap tangent ----");
  {
    // Mirrors the real Vaneo infobox exactly: "related = Mercedes-Benz
    // A-Class (W168)", a clean, single, explicit mention -- and separately,
    // the real A-Class article says nothing about Vaneo at all (confirmed
    // by fetching it directly), so the evidence has to come from the OTHER
    // side, same as the real bug.
    const OMEGA_WIKITEXT = "{{Infobox automobile\n| name = TestOmega Ish\n| related = Mercedes-Benz TestZeta Ish (Z168)\n}}\nIt used the automobile platform from the first generation TestZeta Ish.";
    const ZETA_WIKITEXT = "{{Infobox automobile\n| name = TestZeta Ish\n}}\nA compact car nameplate with two generations.";
    const window = freshWindow((url) => {
      const u = String(url);
      const wt = u.includes("Omega") ? OMEGA_WIKITEXT : ZETA_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-rr-zeta", "Mercedes-Benz", "TestZeta Ish", "TestZeta Ish",
      [{ id: "m-test-rr-zeta-z168", code: "Z168", year: 1997, end: 2004 }, { id: "m-test-rr-zeta-z176", code: "Z176", year: 2012, end: null }]);
    const infoB = genInfo("m-test-rr-omega", "Mercedes-Benz", "TestOmega Ish", "TestOmega Ish",
      [{ id: "m-test-rr-omega", code: "TestOmega Ish", year: 2001, end: 2005 }]);
    // The small local model's own verdict: technically resolved:true, but
    // for the WRONG reason (date overlap, and a made-up code) -- exactly
    // the shape from the real bug report.
    const raw = { resolved: true, codeA: null, codeB: "Z414", reason: "The note does not explicitly name a specific generation for TestZeta Ish. However, it is clear the relationship pertains to TestOmega Ish as it lists its production years which align with the given timeframe." };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "related", null, raw);
    check("AUTO-CONFIRMED from real article evidence (no click needed)", entry.status === "confirmed", entry.status);
    check("pinned the specific Z168 generation (not the whole nameplate)", entry.genIdA === "m-test-rr-zeta-z168", entry.genIdA);
    check("reason credits explicit evidence", /explicit/i.test(entry.reason || ""), entry.reason);
    check("the LLM's own date-overlap tangent is NOT echoed as if it were the reason (would be misleading)",
      !/production years which align/i.test(entry.reason || ""), entry.reason);
  }

  // ---------- scenario 2: Q30-shaped -- code only lives in a piped wikilink's TARGET ----------
  console.log("--- scenario 2: explicit code only in a piped wikilink target, not the display text ----");
  {
    // Exactly the real Q30 infobox shape (confirmed by fetching the live
    // article): "Related: ... Mercedes-Benz A-Class (W176) ..." -- written
    // in real wikitext as a piped link whose DISPLAY text is the plain
    // name and whose TARGET (the actual article title) carries the code.
    const Q_WIKITEXT = "{{Infobox automobile\n| name = TestQ30 Ish\n| related = [[TestInfiniti QX30ish]], [[TestZeta Ish (Z176)|TestZeta Ish]], [[TestGLA Ish (Z156)|TestGLA Ish]]\n}}\nA subcompact executive car.";
    const ZETA_WIKITEXT = "{{Infobox automobile\n| name = TestZeta Ish\n}}\nA compact car nameplate with two generations.";
    const window = freshWindow((url) => {
      const u = String(url);
      const wt = u.includes("Zeta") ? ZETA_WIKITEXT : Q_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-rr-zeta2", "Mercedes-Benz", "TestZeta Ish", "TestZeta Ish",
      [{ id: "m-test-rr-zeta2-z168", code: "Z168", year: 1997, end: 2004 }, { id: "m-test-rr-zeta2-z176", code: "Z176", year: 2012, end: null }]);
    const infoB = genInfo("m-test-rr-q30", "TestInfiniti", "TestQ30 Ish", "TestQ30 Ish",
      [{ id: "m-test-rr-q30", code: "TestQ30 Ish", year: 2016, end: 2019 }]);
    // Same shape as the real bug: the small model itself was unconfident.
    const raw = { resolved: false, codeA: null, codeB: null, reason: "The note does not provide a specific generation of TestZeta Ish. It only mentions the platform used for TestQ30 Ish." };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("AUTO-CONFIRMED purely from the piped wikilink's TARGET code, even though the LLM itself was unconfident",
      entry.status === "confirmed", entry.status);
    check("pinned the specific Z176 generation named in the link target", entry.genIdA === "m-test-rr-zeta2-z176", entry.genIdA);
    check("debug shows the deterministically-extracted code", entry.debug.evidenceCodeForA === "Z176", entry.debug.evidenceCodeForA);
  }

  // ---------- scenario 3: no evidence at all, LLM guesses from years alone -- must NOT resolve ----------
  console.log("--- scenario 3: zero article evidence, LLM's own reason is a bare date-overlap guess ----");
  {
    const A_WIKITEXT = "{{Infobox automobile\n| name = TestAlpha Ish\n}}\nA sedan.";
    const B_WIKITEXT = "{{Infobox automobile\n| name = TestBeta Ish\n}}\nA hatchback.";
    const window = freshWindow((url) => {
      const u = String(url);
      const wt = u.includes("Alpha") ? A_WIKITEXT : B_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-rr-alpha", "TestMk", "TestAlpha Ish", "TestAlpha Ish",
      [{ id: "m-test-rr-alpha-1", code: "Alpha I", year: 2000, end: 2008 }, { id: "m-test-rr-alpha-2", code: "Alpha II", year: 2008, end: null }]);
    const infoB = genInfo("m-test-rr-beta", "TestMk", "TestBeta Ish", "TestBeta Ish",
      [{ id: "m-test-rr-beta", code: "TestBeta Ish", year: 2007, end: 2012 }]);
    const raw = { resolved: true, codeA: "Alpha II", codeB: "TestBeta Ish", reason: "TestAlpha Ish's production years overlap with TestBeta Ish's timeframe, so they correspond to the same era." };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "related", null, raw);
    check("a bare year-overlap guess with zero article evidence is REJECTED, not resolved", entry.status === "none", entry.status);
    check("no generation pinned on either side", entry.genIdA === null && entry.genIdB === null);
  }

  // ---------- scenario 4: no evidence, but LLM's reason genuinely cites explicit text -- must still resolve ----------
  console.log("--- scenario 4: zero deterministic evidence, but a genuine LLM-only resolution still works ----");
  {
    const A_WIKITEXT = "{{Infobox automobile\n| name = TestGamma Ish\n}}\nA coupe.";
    const B_WIKITEXT = "{{Infobox automobile\n| name = TestDelta Ish\n}}\nSaid to be based on the TestGamma Ish Mk2 in a body paragraph the digest didn't happen to pull in as a cue.";
    const window = freshWindow((url) => {
      const u = String(url);
      const wt = u.includes("Gamma") ? A_WIKITEXT : B_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-rr-gamma", "TestMk2", "TestGamma Ish", "TestGamma Ish",
      [{ id: "m-test-rr-gamma-1", code: "Mk1", year: 1995, end: 2002 }, { id: "m-test-rr-gamma-2", code: "Mk2", year: 2002, end: null }]);
    const infoB = genInfo("m-test-rr-delta", "TestMk2", "TestDelta Ish", "TestDelta Ish",
      [{ id: "m-test-rr-delta", code: "TestDelta Ish", year: 2003, end: 2010 }]);
    const raw = { resolved: true, codeA: "Mk2", codeB: "TestDelta Ish", reason: "The Delta Ish's own article explicitly states it's based on the TestGamma Ish Mk2." };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    // This reason attributes the claim to one of the two articles AND names a
    // code out of the real supplied list ("Mk2"), which is exactly the shape
    // Andy asked to stop being asked about: "this should be sufficient
    // information for the program to automatically approve this relationship.
    // I shouldn't have to approve it myself." It now auto-confirms rather than
    // queueing -- what this case still has to prove is that it RESOLVES to the
    // right generation, which the next check does.
    check("a genuine LLM-only resolution (real explicit-naming reason, not a date guess) auto-confirms",
      entry.status === "confirmed", entry.status);
    check("pinned Mk2 as the LLM said", entry.genIdA === "m-test-rr-gamma-2", entry.genIdA);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
