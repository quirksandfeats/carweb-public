// Bugs found by the October 2026 audit, each with what it did on real data.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
function page(store, fetchFn) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/", runScripts: "outside-only" });
  const w = dom.window; global.window = w; global.document = w.document;
  w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
  w.fetch = fetchFn || (async () => ({ ok: true, json: async () => ({}) }));
  w.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {}, rejectedRelations: {}, __serverAvailable: true }, store || {});
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return w;
}
(async () => {
  // A correction stays applied whatever a later re-check says.
  {
    const proposal = { hasMultipleGenerations: true, generations: [{ code: "A1", yearStart: 1990, yearEnd: 1999 }, { code: "B2", yearStart: 2000, yearEnd: 2009 }] };
    const w = page({ recheck: { "fam-x": { status: "applied", proposal, sourceTitle: "X" } } });
    const LF = w.LlmFamilies;
    const fam = () => ({ id: "fam-x", type: "family", label: "X", make: "T", generations: ["g-a1"] });
    const replayed = () => { const f = fam(); const nodes = [f, { id: "g-a1", type: "model", label: "X (A1)", make: "T", familyOf: "fam-x", year: 1990, end: 1999 }]; const links = []; LF.applyAllFamilyOverrides(nodes, links); return f.generations.length; };
    t("an applied correction replays", replayed() === 2, replayed());
    const e = w.LLM_FAMILIES.recheck["fam-x"];
    w.LLM_FAMILIES.recheck["fam-x"] = { status: "none", appliedBefore: e };
    t("...and still does under a later re-check that found nothing new", replayed() === 2, replayed());
  }
  // A refusal that says the two are not related confirms nothing.
  {
    const w = page();
    const LF = w.LlmFamilies;
    const a = { id: "m-a", make: "Ford", label: "Fusion", generations: [{ id: "m-a", code: "Fusion" }] };
    const b = { id: "m-b", make: "Mazda", label: "Mazda6", generations: [{ id: "b1", code: "Mazda6 GG" }, { id: "b2", code: "Mazda6 GJ" }] };
    w.fetch = async (u) => { const s = String(u);
      if (s.includes("/api/llm/chat")) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(cur) } }] }) };
      if (s.includes("wikipedia")) return { ok: true, json: async () => ({ parse: { title: "x", wikitext: { "*": "Ford Fusion and Mazda6 article text." } } }) };
      return { ok: true, json: async () => ({}) }; };
    let cur = { resolved: false, reason: "It is well-known that the Ford Fusion is not related to any Mazda6 generation; there is no shared platform." };
    const e1 = await LF.checkRelation("k1", a, b, "platform", "Ford Fusion and Mazda6 note");
    t("\"well-known that ... is not related\" is not confirmed", e1 && e1.status !== "confirmed", e1 && e1.status);
    cur = { resolved: false, codeB: "Mazda6 GJ", reason: "Real-world knowledge confirms the Fusion shares the CD3 platform with the Mazda6 GG, but the note does not say so." };
    const e2 = await LF.checkRelation("k2", a, b, "platform", "Ford Fusion and Mazda6 note");
    t("a code filled into a refusal does not override what the reason says", !e2 || e2.codeB !== "Mazda6 GJ", e2 && e2.codeB);
  }
  // Auto-decide leaves alone what it cannot judge.
  {
    const nodes = [{ id: "g-leg", type: "model", label: "Legend (KA7)", make: "Acura", sharedPlatformTexts: ["Honda Legend (KA7)"] }, { id: "m-rl", type: "model", label: "RL", make: "Acura" }];
    const w = page({ relations: { "g-leg|m-rl|succession": { status: "provisional", famA: "g-leg", famB: "m-rl", relType: "succession", genIdA: "g-leg", genIdB: "m-rl" } } });
    w.LlmFamilies.autoDecideProvisionalRelations(nodes);
    t("a succession proposal is not judged against platform mentions", !!w.LLM_FAMILIES.relations["g-leg|m-rl|succession"]);
  }
  // Whether an article found by search is about the car.
  {
    const LF = page().LlmFamilies;
    const fits = (text, title, make, model) => LF.articleFitsCar(text, title, make, model);
    t("a person's page is not a car's", !fits("Rudolf Walter Wanderone was a pool player.", "Rudolf Wanderone", "Duesenberg", "Ritz"));
    t("a car covered in another car's article is", fits("{{Infobox automobile}} Sold as the [[Toyota Rush]] in Indonesia.", "Daihatsu Terios", "Toyota", "Rush"));
    t("a disambiguation page is not", !fits("'''Cardinal''' may refer to: Ford Cardinal {{disambiguation}}", "Cardinal", "Ford", "Cardinal"));
    t("an article that never names it is not", !fits("{{Infobox automobile}} A large SUV.", "Nissan Armada", "Nissan", "March third generation"));
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
