// Real user request: rather than hard-coding a new regex for every new
// Wikipedia formatting quirk that trips up the deterministic extraction
// (extractExplicitGenCode), let the local LLM do that normalization work
// itself -- it's a language-understanding task, not a pattern-matching one.
// The response schema now includes "evidenceQuote": a literal, verbatim
// copy of the source text the model is basing its answer on. This is
// checked against the REAL article text before being trusted (quoteVerifies
// + quoteBacksCode in llm_families.js) -- a verified quote earns the exact
// same auto-confirm trust the deterministic regex path gets (llmVerified),
// while an invented or irrelevant "quote" earns nothing extra, same as any
// other hallucination guard in this file.
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
function genInfo(id, make, label, wp, generations) { return { id, make, label, wp, generations }; }

// Deliberately NO parentheses anywhere near the code -- extractExplicitGenCode
// requires a "(CODE)" immediately after the nameplate mention and simply
// cannot parse this phrasing at all, on purpose: this is exactly the class
// of formatting the regex can't generalize to, that the LLM is now asked to
// handle instead.
const DELTA_WIKITEXT = "{{Infobox automobile\n| name = TestDelta Ish\n}}\n" +
  "The TestDelta Ish shares its platform with the TestGamma Ish, specifically the Mk2 model introduced in 2010.";
const GAMMA_WIKITEXT = "{{Infobox automobile\n| name = TestGamma Ish\n}}\nA compact car.";

function makeFetch() {
  return (url) => {
    const u = String(url);
    const wt = u.includes("Delta") ? DELTA_WIKITEXT : GAMMA_WIKITEXT;
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
  };
}
function infos() {
  const infoA = genInfo("fam-test-fmt-gamma", "TestMk", "TestGamma Ish", "TestGamma Ish",
    [{ id: "m-test-fmt-gamma-1", code: "Mk1", year: 1995, end: 2002 }, { id: "m-test-fmt-gamma-2", code: "Mk2", year: 2002, end: null }]);
  const infoB = genInfo("m-test-fmt-delta", "TestMk", "TestDelta Ish", "TestDelta Ish",
    [{ id: "m-test-fmt-delta", code: "TestDelta Ish", year: 2003, end: 2010 }]);
  return { infoA, infoB };
}

(async () => {
  console.log("--- deterministic regex genuinely can't parse this (no parens); a verified LLM quote resolves it anyway ---");
  {
    const window = freshWindow(makeFetch());
    const { infoA, infoB } = infos();
    const raw = {
      resolved: true, codeA: "Mk2", codeB: "TestDelta Ish",
      evidenceQuote: "specifically the Mk2 model introduced in 2010",
      reason: "The Delta Ish's own article explicitly names the Gamma Ish Mk2 as the platform it's based on.",
    };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("deterministic extraction genuinely found nothing (no parens in the source text)", !entry.debug.evidenceCodeForA && !entry.debug.evidenceCodeForB);
    check("the LLM's quote verified against the real article text", entry.debug.quoteVerified === true, entry.debug.quoteVerified);
    check("llmVerified flag set", entry.debug.llmVerified === true, entry.debug.llmVerified);
    check("AUTO-CONFIRMED from the verified LLM quote, even though regex found nothing", entry.status === "confirmed", entry.status);
    check("pinned the specific Mk2 generation the LLM (correctly) identified", entry.genIdA === "m-test-fmt-gamma-2", entry.genIdA);
    check("reason credits the verified quote", /quoted passage/i.test(entry.reason || ""), entry.reason);
  }

  console.log("--- a FABRICATED quote (not real text) is rejected, not trusted ---");
  {
    const window = freshWindow(makeFetch());
    const { infoA, infoB } = infos();
    const raw = {
      resolved: true, codeA: "Mk2", codeB: "TestDelta Ish",
      evidenceQuote: "this exact sentence does not appear anywhere in the real article",
      reason: "The article explicitly names the Gamma Ish Mk2 as the platform donor.",
    };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("quote does NOT verify against the real article text", entry.debug.quoteVerified === false, entry.debug.quoteVerified);
    check("llmVerified is false -- a fabricated quote earns no extra trust", entry.debug.llmVerified === false, entry.debug.llmVerified);
    check("NOT auto-confirmed -- still requires human review despite claiming a quote", entry.status !== "confirmed", entry.status);
    // The plain (unverified) LLM resolution can still count via the older
    // llmResolved tier -- reason isn't a date guess, so it's usable, just
    // not auto-applied.
    check("still resolved at the ordinary (reviewable) tier since the reason itself isn't a date guess", entry.status === "provisional", entry.status);
  }

  console.log("--- a REAL quote that doesn't actually mention the claimed code is rejected ---");
  {
    const window = freshWindow(makeFetch());
    const { infoA, infoB } = infos();
    // Real substring of the actual article text -- but this particular
    // slice doesn't mention "Mk2" OR "TestDelta Ish" (codeB defaults to the
    // nameplate's own name since it's a single-generation side, so the
    // quote has to avoid that too for this to be a clean test of "real
    // quote, wrong code").
    const raw = {
      resolved: true, codeA: "Mk2", codeB: "TestDelta Ish",
      evidenceQuote: "introduced in 2010",
      reason: "The article explicitly states a platform-sharing relationship.",
    };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("quote IS real text from the article", entry.debug.quoteVerified === true, entry.debug.quoteVerified);
    check("but llmVerified is false -- the quote doesn't actually back the claimed code", entry.debug.llmVerified === false, entry.debug.llmVerified);
    check("NOT auto-confirmed -- a real-but-irrelevant quote doesn't get a free pass", entry.status !== "confirmed", entry.status);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
