// Two reported LLM verdicts, same shape: the model answered resolved:false,
// codeA:null, codeB:null -- and then stated the answer in its own reason.
//
//   "...confirms it uses the Volkswagen Group MQB Evo platform, which is also
//    the platform for the current-generation Tiguan (Tiguan AD1/AX1).
//    However, the note does not explicitly state that..."
//
//   "While real-world knowledge confirms the 2006 Concept A was the design
//    precursor to the first-generation Tiguan (5N), the input constraints
//    require that..."
//
// Andy: "if it's confident about sharing a platform... it doesn't need to make
// this request to the user", and "since it says 'real-world knowledge
// confirms...', that should be enough information to automatically confirm
// this relationship on the spot."
//
// The pre-existing knowledgeBacked tier could not help with either, because it
// requires raw.resolved and these are refusals. computeRelationEntry now reads
// the answer back OUT of the refusal (assertedCodeInReason). The whole risk of
// doing that lives in one place -- a refusal is full of mentions the model is
// DISCLAIMING, not asserting -- so most of this file is about that distinction.
//
// Also pinned here: "THERE IS A DIFFERENCE BETWEEN MQB AND MQB EVO PLATFORMS,
// so make sure to be explicit about the platform names when doing the
// matching."
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

function freshWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  // The relation flow fetches both sides' articles; a bland stub is fine here
  // because every case in this file is deliberately about reasoning with NO
  // usable article evidence -- that's the whole situation being tested.
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({
    parse: { title: "x", wikitext: { "*": "A car article with nothing useful in it." } } }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  return window;
}

const TERRAMAR = { id: "m-cupra-terramar", make: "Cupra", label: "Terramar", wp: null,
  generations: [{ id: "g-terr", code: "Terramar", year: 2024, end: null }] };
const TIGUAN = { id: "fam-vw-tiguan", make: "Volkswagen", label: "Tiguan", wp: null, generations: [
  { id: "g-tig-5n", code: "Tiguan 5N", year: 2007, end: 2016 },
  { id: "g-tig-ad1", code: "Tiguan AD1/AX1", year: 2016, end: 2024 },
  { id: "g-tig-ct1", code: "Tiguan CT1", year: 2024, end: null }] };
const CONCEPT_A = { id: "m-vw-concept-a", make: "Volkswagen", label: "Concept A", wp: null,
  generations: [{ id: "g-ca", code: "Concept A", year: 2006, end: 2006 }] };

// Verbatim, as reported.
const REPORTED_TERRAMAR = { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
  reason: "The provided note for the Cupra Terramar confirms it uses the Volkswagen Group MQB Evo platform, which is also the platform for the current-generation Tiguan (Tiguan AD1/AX1). However, the note does not explicitly state that the Tiguan AD1/AX1 is the specific generation related to the Terramar, nor does it mention the Tiguan 5N or CT1 in relation to the Cupra. While automotive knowledge links the MQB Evo platform to both the current Tiguan and the new Cupra Terramar, the instructions require identifying the specific generation from the text or well-established facts where the relationship is named. The prompt's constraint against guessing based solely on year overlap (since 2024 Terramar and 2016 Tiguan AD1 overlap) and the lack of an explicit textual link identifying the Tiguan AD1/AX1 as the 'related' model in the provided note prevents a definitive resolution based strictly on the provided evidence and rules." };
const REPORTED_CONCEPT_A = { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
  reason: "The note provided for the Volkswagen Concept A is insufficient to identify a specific generation code; it only contains the phrase 'Volkswagen Tiguan' which serves as a category or redirect rather than a specific generation identifier (like an ordinal or chassis code). While real-world knowledge confirms the 2006 Concept A was the design precursor to the first-generation Tiguan (5N), the input constraints require that if the provided text does not explicitly name the generation or if the relationship cannot be resolved without guessing from years alone (which is forbidden), the result must be unresolved. Since the note fails to provide the specific generation designation required by the rules, we cannot confidently map it to 'Tiguan 5N' based on the provided evidence." };

(async () => {
  const window = freshWindow();
  const LF = window.LlmFamilies;
  const rel = (a, b, t, note, raw) => LF.previewRelationResult(a, b, t, note, raw);

  console.log("--- the two reported refusals now resolve themselves ---");
  {
    const e = await rel(TERRAMAR, TIGUAN, "platform",
      "Cupra Terramar. Platform: Volkswagen Group MQB Evo.", REPORTED_TERRAMAR);
    check("resolved instead of being thrown away", e.status !== "none", e.status);
    check("AUTO-CONFIRMED -- the user is never asked", e.status === "confirmed", e.status);
    // The important half: of the THREE Tiguan generations named in that
    // reason, only one is named as an assertion. The other two appear inside
    // "nor does it mention the Tiguan 5N or CT1".
    check("picked the generation it ASSERTED (AD1/AX1), not one it disclaimed",
      e.codeB === "Tiguan AD1/AX1", String(e.codeB));
    check("pinned to that generation's actual node", e.genIdB === "g-tig-ad1", String(e.genIdB));
    check("the record explains why a resolved:false became a match",
      /answered "unresolved" but named/.test(e.reason || ""), (e.reason || "").slice(0, 90));
  }
  {
    const e = await rel(CONCEPT_A, TIGUAN, "related", "Volkswagen Tiguan", REPORTED_CONCEPT_A);
    check("the Concept A verdict resolves too", e.status === "confirmed", e.status);
    // Prose writes "the first-generation Tiguan (5N)", never the literal code
    // "Tiguan 5N" -- except in the final sentence, where it's disclaimed
    // ("we cannot confidently map it to 'Tiguan 5N'"). Both facts have to be
    // handled at once to land on 5N here.
    check("matched the bare code out of prose, at generation level",
      e.codeB === "Tiguan 5N" && e.genIdB === "g-tig-5n", `${e.codeB} / ${e.genIdB}`);
  }

  console.log("\n--- a disclaimed mention is never an answer ---");
  {
    // Same cars, same shape, but every mention is negated. This is the exact
    // failure mode a naive substring scan would have.
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
      reason: "Real-world knowledge would be needed here. The note does not name the Tiguan AD1/AX1, nor does it mention the Tiguan 5N or the Tiguan CT1. There is no basis to resolve this." });
    check("a reason that only DENIES mentions resolves nothing", e.status === "none", e.status);
  }
  {
    // Knowledge language but no code from the list at all.
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
      reason: "It is well-established that these two are broadly similar cars from the same group." });
    check("knowledge language with no named generation resolves nothing", e.status === "none", e.status);
  }
  {
    // A code from the list, but no knowledge claim -- just a plain refusal.
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
      reason: "The Tiguan AD1/AX1 exists in the list but the note gives me nothing to work with." });
    check("a bare mention with no knowledge claim resolves nothing", e.status === "none", e.status);
  }
  {
    // Inventing a code that was never offered must not work.
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
      reason: "Real-world knowledge confirms the Terramar shares the MQB Evo platform with the Tiguan XR9 generation." });
    check("a generation that was never in the list can't be salvaged",
      e.codeB !== "Tiguan XR9" && e.genIdB !== "g-tig-xr9", String(e.codeB));
  }

  console.log("\n--- MQB is not MQB Evo ---");
  {
    // "THERE IS A DIFFERENCE BETWEEN MQB AND MQB EVO PLATFORMS." A reason that
    // names a base platform and a qualified version of the SAME base is either
    // conflating them or drawing a distinction fine enough to be worth a look,
    // so it doesn't get to skip review.
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
      reason: "Real-world knowledge confirms the Terramar uses the MQB Evo platform, and the Tiguan 5N uses the MQB platform, so they match." });
    check("a base/variant mix-up does NOT auto-confirm", e.status !== "confirmed", e.status);
  }
  {
    // ...while two genuinely different platforms in one reason are ordinary
    // and must not trip that guard.
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: false, codeA: null, codeB: null, evidenceQuote: null,
      reason: "Real-world knowledge confirms the Terramar shares the MQB Evo platform with the Tiguan AD1/AX1; the older PQ35 platform is unrelated here." });
    check("two genuinely different platform names still auto-confirm",
      e.status === "confirmed" && e.codeB === "Tiguan AD1/AX1", `${e.status} / ${e.codeB}`);
  }
  {
    // The qualifier has to be recognised as part of the name at all -- the old
    // pattern required an all-caps token immediately before "platform", so
    // "MQB Evo platform" wasn't even seen as naming a platform.
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: true, codeA: "Terramar", codeB: "Tiguan AD1/AX1", evidenceQuote: null,
      reason: "Both are built on the MQB Evo platform." });
    check("'MQB Evo platform' counts as naming a platform", e.status === "confirmed", e.status);
  }

  console.log("\n--- the existing bars are untouched ---");
  {
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: true, codeA: "Terramar", codeB: "Tiguan AD1/AX1", evidenceQuote: null,
      reason: "These two feel like similar cars in the same segment." });
    check("a vague resolved:true is still held for review", e.status === "provisional", e.status);
  }
  {
    const e = await rel(TERRAMAR, TIGUAN, "platform", "note", { resolved: true, codeA: "Terramar", codeB: "Tiguan AD1/AX1", evidenceQuote: null,
      reason: "Their production years align, so these are presumably the matching generations." });
    check("a bare year-overlap guess is still rejected outright", e.status === "none", e.status);
  }

  console.log("\n--- the prompt asks for all of this too ---");
  {
    const { messages } = await LF.buildRelationPrompt(TERRAMAR, TIGUAN, "platform", "note");
    const sys = messages.map(m => m.content).join("\n");
    check("the prompt says sharing a platform IS the evidence",
      /SHARING A PLATFORM IS ITSELF THE EVIDENCE/.test(sys));
    check("...and to match platform names exactly, MQB vs MQB Evo",
      /MQB.*and.*MQB Evo.*DIFFERENT platforms/i.test(sys));
    check("...and not to state the answer and then refuse it",
      /Do NOT state the answer and then refuse it/.test(sys));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
