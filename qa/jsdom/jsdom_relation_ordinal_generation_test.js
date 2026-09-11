// Real bug report: checking a relation whose only evidence was "It will be
// built alongside the closely related third-generation Audi Q3" resolved to
// "Q3 F3" -- the SECOND of Q3's three generations (offered codes: 8U, F3,
// FJ) -- instead of "Q3 FJ", the actual THIRD by production year. The LLM's
// own raw response is reproduced here near-verbatim (a resolved:true guess
// naming the wrong code) to prove the fix works even when the model itself
// gets it wrong: gatherRelationEvidence now deterministically counts to the
// Nth-oldest generation (by year) whenever a note names a generation by
// ordinal ("third-generation X") instead of a bare chassis code, and that
// deterministic evidence.codeForA/B always wins over the LLM's own guess in
// computeRelationEntry -- see findOrdinalGeneration's own comment.
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

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

const FAM_ID = "fam-test-ord-q3", G1_ID = "m-test-ord-q3-8u", G2_ID = "m-test-ord-q3-f3", G3_ID = "m-test-ord-q3-fj";
const TERRAMAR_ID = "m-test-ord-terramar";

// Only the Terramar-side article documents the relationship, same real-world
// shape as the A-Class/Q30 evidence test -- the Q3ish article says nothing
// about Terramarish back.
const TERRAMAR_WIKITEXT = "{{Infobox automobile\n| name = TestAudi Terramarish\n}}\n" +
  "It will be built alongside the closely related third-generation TestAudi Q3ish.";
const Q3_WIKITEXT = "{{Infobox automobile\n| name = TestAudi Q3ish\n}}\nA compact crossover nameplate now in its third generation.";

let lastOllamaBody = null;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    const wt = u.includes("Terramarish") ? TERRAMAR_WIKITEXT : Q3_WIKITEXT;
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    lastOllamaBody = body;
    // Reproduces the real bug report's own wrong answer near-verbatim:
    // resolved:true, but naming the SECOND generation (F3ish) instead of
    // the actual third (FJish) -- proves the deterministic evidence path
    // corrects this rather than trusting the model's own (wrong) verdict.
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        resolved: true, codeA: "Q3ish F3ish", codeB: null,
        evidenceQuote: "It will be built alongside the closely related third-generation TestAudi Q3ish.",
        reason: null,
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

const DATA = window.CARDATA;
let audiMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestAudi");
if (!audiMake) { audiMake = { id: "mk-test-ord-audi", type: "make", label: "TestAudi", year: 1950 }; DATA.nodes.push(audiMake); }

const fam = { id: FAM_ID, type: "family", label: "Q3ish", make: "TestAudi", wp: "TestAudi Q3ish", year: 2011, end: null,
  designers: [], engineers: [], generations: [G1_ID, G2_ID, G3_ID] };
// Years matter: G3 (FJish) must be the chronologically THIRD generation for
// the deterministic ordinal count to prove anything.
const g1 = { id: G1_ID, type: "model", label: "Q3ish 8Uish", make: "TestAudi", year: 2011, end: 2018, familyOf: FAM_ID };
const g2 = { id: G2_ID, type: "model", label: "Q3ish F3ish", make: "TestAudi", year: 2018, end: 2023, familyOf: FAM_ID };
const g3 = { id: G3_ID, type: "model", label: "Q3ish FJish", make: "TestAudi", year: 2023, end: null, familyOf: FAM_ID };
const terramar = { id: TERRAMAR_ID, type: "model", label: "Terramarish", make: "TestAudi", wp: "TestAudi Terramarish", year: 2024, end: null };
DATA.nodes.push(fam, g1, g2, g3, terramar);
DATA.links.push({ source: FAM_ID, target: audiMake.id, type: "made" }, { source: TERRAMAR_ID, target: audiMake.id, type: "made" });
DATA.links.push(
  { source: FAM_ID, target: G1_ID, type: "generation" },
  { source: FAM_ID, target: G2_ID, type: "generation" },
  { source: FAM_ID, target: G3_ID, type: "generation" },
  { source: G1_ID, target: G2_ID, type: "gensucc" },
  { source: G2_ID, target: G3_ID, type: "gensucc" },
);
// Build-time-harvested coarse "related" link, no note -- same real-world
// shape as the A-Class/Q30 test.
DATA.links.push({ source: FAM_ID, target: TERRAMAR_ID, type: "related" });

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
cw.setLlmCheck(true);

cw.openDetail(fam);

setTimeout(() => {
  const key = [FAM_ID, TERRAMAR_ID].sort().join("|") + "|related";
  const entry = window.LlmFamilies.relationEntryFor(key);
  check("relation entry was persisted", !!entry);
  check("the LLM's own raw guess named the WRONG (second) generation -- test precondition, proves this isn't just trusting a correct LLM answer",
    !!lastOllamaBody);
  check("resolved down to a specific generation, not left at nameplate level", entry && entry.genIdA, entry && entry.genIdA);
  check("resolved to Q3ish FJish (the ACTUAL third generation by year), not F3ish (the LLM's own wrong guess)",
    entry && entry.genIdA === G3_ID, entry && entry.genIdA);
  check("NOT the LLM's own mistaken pick", entry && entry.genIdA !== G2_ID);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}, 50);
