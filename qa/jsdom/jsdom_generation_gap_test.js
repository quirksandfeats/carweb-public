// Real user request: "if the program is checking the relation to another car
// model which is also a nameplate, it should first verify with the wikipedia
// of that nameplate to make sure that the generations are in order."
//
// This covers the deterministic decision: does the stored generation list look
// out of date against the article? Getting it wrong is costly both ways -- a
// missed gap leaves the match picking from a stale list (the Mazda6 case), an
// invented one sends a perfectly current nameplate off for a pointless
// re-check. The awkward part is that the same generation is written several
// ways: "Third generation (GJ; 2012)" as a heading, "Mazda6 (third
// generation)" or bare "GJ" in the graph, "Mk7" here and "seventh generation"
// there. Driven through the public generationGapFor(info, digest), which takes
// a digest directly so no article is ever fetched.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { url: "http://localhost:8077/", runScripts: "outside-only" });
const w = dom.window;
global.window = w; global.document = w.document;
w.LLM_FAMILIES = { __serverAvailable: false, families: {} };
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
w.fetch = async () => { throw new Error("no article should be fetched in this test"); };
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;

const mazda6Digest = {
  headings: ["First generation (GG; 2002)", "Second generation (GH; 2007)",
             "Third generation (GJ; 2012)", "Fourth generation (2022)",
             "Safety", "Motorsport", "References"],
  perGenInfoboxes: [{ heading: "Third generation (GJ; 2012)" }],
};
const info = (gens) => ({ id: "n1", make: "Mazda", label: "Mazda6", wp: "Mazda6",
                          generations: gens.map((c, i) => ({ id: "g" + i, code: c })) });

(async () => {
  // the reported case: article has four, database has two
  const gap = await LF.generationGapFor(info(["Mazda6", "Mazda6 (third generation)"]), mazda6Digest);
  t("a stale list is reported as a gap", !!gap, JSON.stringify(gap));
  t("...counting what the article names vs what's held",
    gap && gap.wikiCount === 4 && gap.heldCount === 2, gap && [gap.wikiCount, gap.heldCount].join("/"));
  t("...listing only the ones genuinely absent (not the third gen it has)",
    gap && gap.missing.length === 3 && !gap.missing.some(m => /third/i.test(m)),
    gap && JSON.stringify(gap.missing));

  // a current list, in each spelling the data actually uses
  for (const [name, held] of [
    ["ordinal wording", ["First generation (GG)", "Second generation (GH)", "Third generation (GJ)", "Fourth generation"]],
    ["bare chassis codes", ["GG", "GH", "GJ", "Fourth generation"]],
    ["nameplate-prefixed", ["Mazda6 (first generation)", "Mazda6 (second generation)", "Mazda6 (third generation)", "Mazda6 (fourth generation)"]],
  ]) t("a current list reports no gap — " + name,
       (await LF.generationGapFor(info(held), mazda6Digest)) === null);

  // Mk-numbers and ordinals are the same scale
  t("Mk headings match an ordinal-worded stored list",
    (await LF.generationGapFor(
      { id: "g", make: "VW", label: "Golf", wp: "Volkswagen Golf",
        generations: [{ id: "1", code: "First generation" }, { id: "2", code: "Second generation" }, { id: "7", code: "Seventh generation" }] },
      { headings: ["Mk1 (1974)", "Mk2 (1983)", "Mk7 (2012)"] })) === null);

  // chassis codes against a prefixed stored label
  t("chassis-code headings match a prefixed stored label",
    (await LF.generationGapFor(
      { id: "gc", make: "Mercedes-Benz", label: "G-Class", wp: "Mercedes-Benz G-Class",
        generations: [{ id: "a", code: "G-Class (W460)" }, { id: "b", code: "G-Class (W463)" }] },
      { headings: ["W460 (1979–1991)", "W463", "Trivia"] })) === null);

  // and the quiet cases
  t("an article with no generation headings yields no gap",
    (await LF.generationGapFor(info(["Mazda6"]), { headings: ["History", "Design", "Sales"] })) === null);
  t("a car with no Wikipedia link is skipped entirely",
    (await LF.generationGapFor({ id: "x", label: "X", generations: [] }, mazda6Digest)) === null);

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
