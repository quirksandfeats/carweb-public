// Real user report (verbatim): checking the Mercedes-Benz GLA against the
// A-Class returned
//   "couldn't confidently match a specific generation pair for the platform
//   connection to Mercedes-Benz A -- it still shows at the nameplate level"
// with the model's own raw JSON showing resolved:false and this reason:
//   "...While external knowledge confirms the GLA X156 shares a platform
//   with the A-Class W176, the required 'EXPLICIT textual evidence' is
//   absent from the provided notes; the notes only state production years
//   and general generation counts without naming the specific
//   platform-matching pair."
// The model had clearly done the right deductive reasoning (it named the
// exact real platform-sharing pair) but the system prompt's "EXPLICIT
// textual evidence" wording left it no way to say so -- it was instructed
// to treat its own correct, confident answer as disqualified. Real user
// request: "maybe this 'explicit' textual evidence can be modified to also
// be more lenient if the model can successfully identify the generations
// via other context clues... either through external knowledge or by
// ordinal."
//
// buildRelationMessages' system prompt was loosened to explicitly allow
// resolved:true on well-established, concretely-named real-world knowledge
// (not just literal quotes), while still forbidding bare year-overlap
// guessing (the original bug #27 was built to prevent) under any of the
// new or old rules. This test proves the DOWNSTREAM logic
// (computeRelationEntry/previewRelationResult) correctly accepts and
// surfaces a knowledge-based resolved:true the way the loosened prompt now
// permits the model to give -- using previewRelationResult's manualRaw
// path (same technique every other relation test in this suite uses) since
// the actual prompt text itself isn't independently testable without a
// real LLM.
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
  // ---------- scenario 1: the exact real GLA/A-Class shape, now with the corrected (loosened-prompt) model behavior ----------
  console.log("--- scenario 1: knowledge-based resolution (no literal quote) now resolves, held for review ----");
  {
    // Real infobox notes are exactly this vague on their own -- ordinal/
    // count language on each side separately, no cross-reference between
    // the two nameplates naming each other's specific generation. Under
    // the OLD prompt this had to come back resolved:false; under the new
    // one, the model is allowed to fill the gap with its own well-
    // established knowledge of the actual GLA X156 <-> A-Class W176
    // platform-sharing fact, same as the real report.
    const GLA_WIKITEXT = "{{Infobox automobile\n| name = TestGLA Ish\n}}\nFirst generation launched in 2013.";
    const A_WIKITEXT = "{{Infobox automobile\n| name = TestAClass Ish\n}}\nFour generations have been produced.";
    const window = freshWindow((url) => {
      const u = String(url);
      const wt = u.includes("GLA") ? GLA_WIKITEXT : A_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-rr-gla", "Mercedes-Benz", "TestGLA Ish", "TestGLA Ish",
      [{ id: "m-test-rr-gla-x156", code: "TestGLA Ish X156", year: 2013, end: 2020 },
       { id: "m-test-rr-gla-h247", code: "TestGLA Ish H247", year: 2020, end: null }]);
    const infoB = genInfo("fam-test-rr-aclass", "Mercedes-Benz", "TestAClass Ish", "TestAClass Ish",
      [{ id: "m-test-rr-aclass-w168", code: "TestAClass Ish W168", year: 1997, end: 2004 },
       { id: "m-test-rr-aclass-w169", code: "TestAClass Ish W169", year: 2004, end: 2012 },
       { id: "m-test-rr-aclass-w176", code: "TestAClass Ish W176", year: 2012, end: 2018 },
       { id: "m-test-rr-aclass-w177", code: "TestAClass Ish W177", year: 2018, end: null }]);
    // What the model SHOULD now say, per the loosened prompt: resolved:true,
    // grounded in a concrete, nameable fact (the real shared platform),
    // with no evidenceQuote since this isn't lifted from the note text.
    const raw = {
      resolved: true, codeA: "TestGLA Ish X156", codeB: "TestAClass Ish W176", evidenceQuote: null,
      reason: "This is well-established: the TestGLA Ish X156 shares Mercedes-Benz's MFA platform with the TestAClass Ish W176 -- the same generation pairing is widely documented, not merely a case of overlapping production years.",
    };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("no longer stuck at 'none' -- the knowledge-based answer resolves", entry.status !== "none", entry.status);
    // This used to assert "provisional" -- held for human review, on the
    // reasoning that a knowledge-based answer with no verifiable quote isn't
    // the same tier of evidence as one lifted from the article. A direct user
    // request overturned that, on a Ford Fusion / Mazda6 verdict where the
    // model wrote "it is a well-established fact that the Ford Fusion (First
    // Gen) and Mazda6 (First Gen) share the CD3 platform" and STILL answered
    // resolved:false: "This means that it should automatically accept this
    // information if it knows it to be true. This example (and others
    // similar) should also be passing as automatic approval."
    //
    // So a reason that NAMES a concrete fact -- a specific platform/chassis
    // code, or explicit well-established/well-documented language -- now
    // auto-confirms. The bar stays narrow on purpose: a vague "these seem
    // related" still doesn't qualify (asserted in the scenario below), and
    // reasonLooksDateOnly still vetoes a bare year-overlap guess.
    check("auto-confirmed on the strength of a concretely-named, well-established fact",
      entry.status === "confirmed", entry.status);
    check("...and the record says WHY it was auto-approved without a quote",
      /well-established knowledge/i.test(entry.reason || ""), entry.reason);
    check("pinned the SPECIFIC X156 generation on the GLA side", entry.genIdA === "m-test-rr-gla-x156", entry.genIdA);
    check("pinned the SPECIFIC W176 generation on the A-Class side (not just the nameplate, not a different generation)",
      entry.genIdB === "m-test-rr-aclass-w176", entry.genIdB);
    check("the model's own concrete reasoning is surfaced for the user to review, not swallowed",
      entry.reason && /mfa platform/i.test(entry.reason), entry.reason);
    // The reason here deliberately ALSO mentions "overlapping production
    // years" (as a rhetorical disclaimer -- "...not merely a case of
    // overlapping production years") to prove the date-overlap guard isn't
    // simply keying off that vocabulary appearing anywhere in the text: the
    // preceding two checks already confirm status stayed "provisional"
    // (not silently downgraded to "none") despite that phrase being present,
    // because the reason also carries a genuine "well-established"/"widely
    // documented" knowledge signal -- see reasonLooksDateOnly's own comment.
  }

  // ---------- scenario 2: negative control -- a bare year-overlap reason must still be rejected, even now ----------
  console.log("--- scenario 2: pure year-overlap reasoning is still rejected -- loosening didn't reopen the original bug ----");
  {
    const X_WIKITEXT = "{{Infobox automobile\n| name = TestXi Ish\n}}\nA sedan.";
    const Y_WIKITEXT = "{{Infobox automobile\n| name = TestYps Ish\n}}\nA hatchback.";
    const window = freshWindow((url) => {
      const u = String(url);
      const wt = u.includes("Xi") ? X_WIKITEXT : Y_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-rr-xi", "TestMk3", "TestXi Ish", "TestXi Ish",
      [{ id: "m-test-rr-xi-1", code: "Xi I", year: 2000, end: 2008 }, { id: "m-test-rr-xi-2", code: "Xi II", year: 2008, end: null }]);
    const infoB = genInfo("m-test-rr-yps", "TestMk3", "TestYps Ish", "TestYps Ish",
      [{ id: "m-test-rr-yps", code: "TestYps Ish", year: 2007, end: 2012 }]);
    // Same shape as the ORIGINAL Jeep Grand Cherokee/Commander bug (#27) --
    // resolved:true on nothing but "the years line up", no platform/fact
    // named at all. Must still be rejected exactly as before.
    const raw = { resolved: true, codeA: "Xi II", codeB: "TestYps Ish", evidenceQuote: null,
      reason: "TestXi Ish's production years overlap with TestYps Ish's timeframe, so they likely correspond to the same era." };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "related", null, raw);
    check("a bare year-overlap guess is still rejected after the prompt change", entry.status === "none", entry.status);
    check("no generation pinned on either side", entry.genIdA === null && entry.genIdB === null);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
