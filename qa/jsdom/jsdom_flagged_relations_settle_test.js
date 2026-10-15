// Relationships an older re-check flagged "may need removing", settled.
// The owner's rulings (14 Oct 2026): a relationship one article names is kept
// ("it likely means that the Vitz page was incomplete"); only one neither
// article names goes. And a "its generation would be retired" flag goes once
// the re-check behind it is decided or retires nothing.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const ARTICLES = {
  "TestF Yaris": "The [[TestF Vitz|Vitz]] was sold in Japan.",
  "TestF Vitz": "A small car.",
  "TestF Alpha": "A car with nothing in common.",
  "TestF Omega": "Another car.",
};
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/", runScripts: "outside-only" });
const w = dom.window; global.window = w; global.document = w.document;
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
w.fetch = async (url, opts) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m && u.includes("prop=wikitext")) {
    const title = decodeURIComponent(m[1]);
    return { ok: true, json: async () => ARTICLES[title] ? { parse: { title, wikitext: { "*": ARTICLES[title] } } } : { error: { code: "missingtitle" } } };
  }
  return { ok: true, json: async () => ({}) };
};
const flag = reason => ({ kind: "remove", checkedAt: "2026-10-13T00:00:00Z", reason });
w.LLM_FAMILIES = {
  families: {}, rejectedRelations: {}, __serverAvailable: true,
  recheck: {
    "fam-yaris": { status: "none" },
    "fam-alpha": { status: "provisional", proposal: { generations: [{ code: "A1", yearStart: 2000, yearEnd: 2005 }] }, sourceTitle: "TestF Alpha" },
  },
  relations: {
    "y|v|related": { status: "confirmed", famA: "fam-yaris", famB: "m-vitz", relType: "related", genIdA: "g-yaris-1",
                     reworkPending: flag("the current article text no longer mentions TestF Vitz alongside Yaris (XP10) -- this re-check couldn't confirm the match still holds") },
    "a|o|platform": { status: "confirmed", famA: "fam-alpha", famB: "m-omega", relType: "platform", genIdA: "g-alpha-1",
                      reworkPending: flag("the current article text no longer mentions TestF Omega alongside Alpha (A1) -- this re-check couldn't confirm the match still holds") },
    "y2|v|platform": { status: "confirmed", famA: "fam-yaris", famB: "m-vitz", relType: "platform", genIdA: "g-yaris-1",
                       reworkPending: flag("the generation this connected (Yaris (XP10)) no longer appears in the current article -- this re-check would retire it") },
    "a2|o|related": { status: "confirmed", famA: "fam-alpha", famB: "m-omega", relType: "related", genIdA: "g-alpha-1",
                      reworkPending: flag("the generation this connected (Alpha (A1)) no longer appears in the current article -- this re-check would retire it") },
  },
};
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;
const nodes = [
  { id: "fam-yaris", type: "family", label: "Yaris", make: "TestF", wp: "TestF Yaris", generations: ["g-yaris-1"] },
  { id: "g-yaris-1", type: "model", label: "Yaris (XP10)", make: "TestF", familyOf: "fam-yaris", year: 1999, end: 2005 },
  { id: "m-vitz", type: "model", label: "Vitz", make: "TestF", wp: "TestF Vitz" },
  { id: "fam-alpha", type: "family", label: "Alpha", make: "TestF", wp: "TestF Alpha", generations: ["g-alpha-1"] },
  { id: "g-alpha-1", type: "model", label: "Alpha (A1)", make: "TestF", familyOf: "fam-alpha", year: 2000, end: 2005 },
  { id: "m-omega", type: "model", label: "Omega", make: "TestF", wp: "TestF Omega" },
];
const R = w.LLM_FAMILIES.relations;

const cleared = LF.settleRetiredGenerationFlags(nodes);
t("a retirement flag whose re-check is decided is cleared", !R["y2|v|platform"].reworkPending);
t("...one whose re-check pairs the generation (nothing retired) is cleared too", !R["a2|o|related"].reworkPending, cleared);

(async () => {
  const r = await LF.sweepFlaggedMentions(nodes);
  t("a relationship one article names is kept, its flag cleared (the Yaris names the Vitz)",
    R["y|v|related"] && !R["y|v|related"].reworkPending);
  t("a relationship neither article names is removed, and not proposed again",
    !R["a|o|platform"] && w.LLM_FAMILIES.rejectedRelations["a|o|platform"] === true, JSON.stringify(r));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
