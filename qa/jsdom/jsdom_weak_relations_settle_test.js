// The weak proposals (a loose name match on overlapping years), settled.
// The owner's ruling (14 Oct 2026): confirmed when the article the mention was
// found in names the matched car in full or links to its article; declined
// otherwise; the other car's article plays no part. One answered from
// connections already in the graph is confirmed.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const ARTICLES = {
  "TestW Corolla": "The E80 was sold in Australia as the [[TestW Nova|Nova]] by Holden.",
  "TestW Explorer": "The TestW MKT shared its platform.",
  "TestW Sapporo": "A coupé of the 1970s.",
  "TestW Colt": "The Sapporo was built alongside it.",
};
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/", runScripts: "outside-only" });
const w = dom.window; global.window = w; global.document = w.document;
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
w.fetch = async url => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m && String(url).includes("prop=wikitext")) {
    const title = decodeURIComponent(m[1]);
    return { ok: true, json: async () => ARTICLES[title] ? { parse: { title, wikitext: { "*": ARTICLES[title] } } } : { error: {} } };
  }
  return { ok: true, json: async () => ({}) };
};
const prov = (a, b, extra) => Object.assign({ status: "provisional", famA: a, famB: b, relType: "platform" }, extra || {});
w.LLM_FAMILIES = { families: {}, recheck: {}, rejectedRelations: {}, __serverAvailable: true, relations: {
  "corolla|nova|platform": prov("m-corolla", "m-nova"),
  "explorer|mkt|platform": prov("m-explorer", "m-mkt"),
  "sapporo|colt|platform": prov("m-sapporo", "m-colt"),
  "p911|boxster|related": prov("m-911", "m-boxster", { relType: "related", matchLevel: "transitive" }),
} };
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;
const car = (id, label, wp) => ({ id, type: "model", label, make: "TestW", wp });
const nodes = [car("m-corolla", "Corolla (E80)", "TestW Corolla"), car("m-nova", "Nova", "TestW Nova"),
  car("m-explorer", "Explorer", "TestW Explorer"), car("m-mkt", "MKT", "TestW MKT"),
  car("m-sapporo", "Sapporo", "TestW Sapporo"), car("m-colt", "Colt", "TestW Colt"),
  car("m-911", "911", "TestW 911"), car("m-boxster", "Boxster", "TestW Boxster")];
(async () => {
  const r = await LF.sweepWeakRelations(nodes);
  const R = w.LLM_FAMILIES.relations;
  t("a link to the matched car's article confirms it", R["corolla|nova|platform"].status === "confirmed");
  t("its make and name in the text confirm it", R["explorer|mkt|platform"].status === "confirmed");
  t("only the other car's article naming it does not: declined", !R["sapporo|colt|platform"] && w.LLM_FAMILIES.rejectedRelations["sapporo|colt|platform"]);
  t("an answer from connections already in the graph is confirmed", R["p911|boxster|related"].status === "confirmed", JSON.stringify(r));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
