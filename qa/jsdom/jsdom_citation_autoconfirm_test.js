// Real user request, on an Acura Legend <-> Acura RL KA9 succession verdict
// that was queued for approval instead of applied:
//
//   "POSSIBLE SPECIFIC MATCH FOR THE SUCCESSION CONNECTION TO ACURA RL KA9 —
//    UNVERIFIED ... The RL KA9 article explicitly states that the
//    first-generation RL replaced the second-generation Acura Legend. The code
//    list for Car A distinguishes between the First (1985-1990) and Second
//    (1990-1995) generations. Since the replacement occurred in 1996, the
//    relationship applies to the Second generation of the Legend, which
//    corresponds to the code 'Acura Legend Second generation (1991)
//    (1990–1995)'. The RL KA9 code matches the specific generation named in
//    the text as the successor."
//
//   "In this case, this should be sufficient information for the program to
//    automatically approve this relationship. I shouldn't have to approve it
//    myself."
//
// The properties that actually matter, and are asserted below:
//   * that exact verdict auto-confirms
//   * the tier needs BOTH halves -- article attribution AND a code out of the
//     real list this car was given -- so neither alone is enough
//   * a code the reason DISCLAIMS never counts (that's the failure mode any
//     "trust the prose" rule has to be safe against)
//   * a bare year-overlap guess is still refused, however confidently worded
//   * the confirmed code must be the one the match actually landed on
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

// The real code lists from Andy's own graph.
const LEGEND = {
  id: "m-acura-legend", make: "Acura", label: "Legend", wp: "Acura Legend",
  generations: [
    { id: "g-legend-1", code: "First generation (1986)", year: 1985, end: 1990 },
    { id: "g-legend-2", code: "Second generation (1991)", year: 1990, end: 1995 },
  ],
};
const RL = {
  id: "m-acura-rl", make: "Acura", label: "RL", wp: "Acura RL",
  generations: [
    { id: "g-rl-ka9", code: "KA9", year: 1996, end: 2004 },
    { id: "g-rl-kb1", code: "KB1", year: 2005, end: 2012 },
  ],
};
const ANDYS_REASON =
  "The RL KA9 article explicitly states that the first-generation RL replaced the second-generation " +
  "Acura Legend. The code list for Car A distinguishes between the First (1985-1990) and Second " +
  "(1990-1995) generations. Since the replacement occurred in 1996, the relationship applies to the " +
  "Second generation of the Legend, which corresponds to the code 'Acura Legend Second generation " +
  "(1991) (1990–1995)'. The RL KA9 code matches the specific generation named in the text as the successor.";

function freshWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  global.window = window;
  global.document = window.document;
  window.eval(fs.readFileSync(path.join(APP, "d3.min.js"), "utf-8"));
  window.eval(fs.readFileSync(path.join(APP, "data.js"), "utf-8"));
  window.LLM_FAMILIES = { families: {}, relations: {}, __serverAvailable: true };
  window.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return window;
}

// computeRelationEntry isn't exported (it's an internal of the relation
// pipeline), so drive it the way the pipeline does: stub the LLM transport and
// call checkRelation with an empty-evidence path, which is exactly the
// situation Andy's verdict came from -- no chassis code in either article.
function verdictFor(window, raw, note) {
  const LF = window.LlmFamilies;
  window.__reply = raw;
  return LF.checkRelation(
    "test|" + Math.random(), LEGEND, RL, "succession",
    // Deliberately carries NO ordinal phrase. The existing ordinal-corroboration
    // tier reads "the second-generation Acura Legend" straight out of the note
    // and auto-confirms on its own -- which would mask whether the new tier
    // works at all. This note leaves the model's REASON as the only thing that
    // can possibly confirm the match, which is exactly Andy's situation.
    note !== undefined ? note : "Succeeded by the Acura RL.");
}

function withStubbedLlm(fn) {
  const window = freshWindow();
  // askLlamaCpp posts to /api/llm/chat; answer with whatever __reply holds.
  window.fetch = (url, opts) => {
    if (String(url).includes("/api/llm")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(window.__reply) } }] }),
      });
    }
    // Wikipedia digests: answer "no article", so no deterministic code can be
    // extracted and the reason is the ONLY thing that can confirm the match.
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };
  return fn(window);
}

(async () => {
  console.log("--- Andy's exact Acura Legend / RL KA9 verdict ---");
  await withStubbedLlm(async window => {
    const e = await verdictFor(window, {
      resolved: true, codeA: "Second generation (1991)", codeB: "KA9", reason: ANDYS_REASON,
    });
    check("it resolves to a specific generation pair", e.matchLevel === "generation", e.matchLevel);
    check("...on the SECOND generation of the Legend", e.codeA === "Second generation (1991)", e.codeA);
    check("...against the RL KA9", e.codeB === "KA9", e.codeB);
    check("it auto-confirms instead of asking", e.status === "confirmed", e.status + " / " + JSON.stringify(e.reason));
    check("...and records why", e.autoConfirmed === true && /attributed this to one of the two Wikipedia articles/.test(e.reason || ""));
    check("the debug trail names the cited codes",
      e.debug.citationBacked === true && e.debug.citedA === "Second generation (1991)",
      JSON.stringify({ a: e.debug.citedA, b: e.debug.citedB }));
  });

  console.log("\n--- both halves are required ---");
  await withStubbedLlm(async window => {
    // Attribution, but the code it names isn't in either car's list.
    const e = await verdictFor(window, {
      resolved: true, codeA: "Second generation (1991)", codeB: "KA9",
      reason: "The article explicitly states that the RL replaced the Legend Mark IV.",
    });
    check("attribution alone, with no real code named, does NOT auto-confirm",
      e.status === "provisional", e.status);
  });
  await withStubbedLlm(async window => {
    // A real code, but no citation -- just an assertion.
    const e = await verdictFor(window, {
      resolved: true, codeA: "Second generation (1991)", codeB: "KA9",
      reason: "I think the Second generation (1991) is probably the right one here.",
    });
    check("a named code with no article citation does NOT auto-confirm",
      e.status === "provisional", e.status);
  });

  console.log("\n--- the safety rules the tier must not break ---");
  await withStubbedLlm(async window => {
    const e = await verdictFor(window, {
      resolved: true, codeA: "Second generation (1991)", codeB: "KA9",
      reason: "The article does not state which generation, and never mentions the Second generation (1991) at all.",
    });
    check("a DISCLAIMED code never counts as cited", e.status === "provisional", e.status);
  });
  await withStubbedLlm(async window => {
    const e = await verdictFor(window, {
      resolved: true, codeA: "Second generation (1991)", codeB: "KA9",
      reason: "The article states these are related. The production years align: Second generation (1991) ran 1990-1995 and the KA9 began in 1996, so the model years match up.",
    });
    // "none" (refused outright) is an even stronger answer than "provisional"
    // here -- either way it must not reach the graph without a human.
    check("a bare year-overlap guess is still refused, citation or not",
      e.status !== "confirmed", e.status + " / " + (e.reason || "").slice(0, 80));
  });
  await withStubbedLlm(async window => {
    // Cites the article about the FIRST generation, but the match landed on
    // the second -- the citation is not evidence for the pair being confirmed.
    const e = await verdictFor(window, {
      resolved: true, codeA: "Second generation (1991)", codeB: "KA9",
      reason: "The article explicitly states this concerns the First generation (1986).",
    });
    check("a citation about a DIFFERENT generation than the match does not confirm it",
      e.status === "provisional", e.status);
  });

  console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
