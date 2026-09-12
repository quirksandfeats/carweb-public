// Real user question: "so for the thumbnails to be proper, do i need to do a
// rebuild or what?" No. rebuild.sh regenerates cars.json from DBpedia and the
// curated tables and never touches llm_families.json, which is where a
// generation's photo lives. wikiFile is written once, by validate(), when that
// family was scanned -- so an improvement to findGenerationImage only reaches
// families scanned afterwards.
//
// refreshGenerationImages re-reads the article and recomputes ONLY that
// pointer. What this pins is everything it must NOT do: it must not touch
// codes, years, credits or a family's confirmed status, it must not blank a
// photo that finds nothing this time, and it must not hand two generations the
// same photo. Plus the default/all split, and that it saves.
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const pad = (l, n) => "\n" + (l + " filler. ").repeat(n) + "\n";
// No generation headings; photos only in infobox `image =` params -- the real
// Mercedes-Benz GLA's shape, which is what produced the empty thumbnails.
const GLA = [
  "{{Infobox automobile\n| name = GLA\n| image = Lead photo.jpg\n}}",
  pad("lead", 30),
  "'''X156'''",
  "{{Infobox automobile\n| name = GLA (X156)\n| image = X156 photo.jpg\n}}",
  pad("first generation", 40),
  "'''H247'''",
  "{{Infobox automobile\n| name = GLA (H247)\n| image = H247 photo.jpg\n}}",
  pad("second generation", 40),
].join("\n");

function freshLF(seed, articles) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "http://localhost:8077/", runScripts: "outside-only" });
  const w = dom.window;
  global.window = w; global.document = w.document;
  w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
  w.LLM_FAMILIES = seed;
  const saved = [];
  w.fetch = async (url, opts) => {
    if (String(url).startsWith("/api/llm-families")) {
      saved.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    const m = String(url).match(/[?&]page=([^&]+)/);
    const title = decodeURIComponent(m ? m[1] : "");
    if (!(title in articles)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ parse: { title, wikitext: { "*": articles[title] } } }) };
  };
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return { LF: w.LlmFamilies, saved };
}

const entry = gens => ({
  status: "confirmed",
  checkedAt: "2026-09-11T00:00:00.000Z",
  sourceTitle: "Mercedes-Benz GLA",
  proposal: { hasMultipleGenerations: true, generations: gens },
});
const gen = (code, wikiFile) => ({ code, yearStart: 2013, yearEnd: 2019,
  designers: ["Robert Lešnik"], engineers: [], wikiFile, sharedPlatforms: ["Mercedes-Benz A-Class (W176)"] });

(async () => {
  // ---- the reported case: two generations, neither with a photo -----------
  {
    const seed = { families: { "m-mb-gla": entry([gen("X156", null), gen("H247", null)]) },
                   relations: {}, __serverAvailable: true };
    const { LF, saved } = freshLF(seed, { "Mercedes-Benz GLA": GLA });
    const res = await LF.refreshGenerationImages();
    const gens = seed.families["m-mb-gla"].proposal.generations;

    t("both empty generations are filled", res.filled === 2 && res.replaced === 0, JSON.stringify(res));
    t("...each from its own infobox", gens[0].wikiFile === "X156 photo.jpg" && gens[1].wikiFile === "H247 photo.jpg",
      gens.map(g => g.wikiFile).join(" / "));
    t("...and never the same photo twice", gens[0].wikiFile !== gens[1].wikiFile);
    t("the result lists what changed, for the graph to pick up",
      res.updates.length === 2 && res.updates[0].familyId === "m-mb-gla" && res.updates[0].code === "X156",
      JSON.stringify(res.updates));
    t("it saves", saved.length === 1 &&
      saved[0].families["m-mb-gla"].proposal.generations[0].wikiFile === "X156 photo.jpg");

    // The whole reason not to re-run the check.
    t("the confirmation survives", seed.families["m-mb-gla"].status === "confirmed");
    t("years, credits and platforms are untouched",
      gens[0].yearStart === 2013 && gens[0].yearEnd === 2019 &&
      gens[0].designers.join() === "Robert Lešnik" &&
      gens[0].sharedPlatforms.join() === "Mercedes-Benz A-Class (W176)");
    t("codes are untouched", gens[0].code === "X156" && gens[1].code === "H247");
  }

  // ---- default only fills gaps; a held photo is left alone ----------------
  {
    const seed = { families: { "m-mb-gla": entry([gen("X156", "Something chosen by hand.jpg"), gen("H247", null)]) },
                   relations: {}, __serverAvailable: true };
    const { LF } = freshLF(seed, { "Mercedes-Benz GLA": GLA });
    const res = await LF.refreshGenerationImages();
    const gens = seed.families["m-mb-gla"].proposal.generations;
    t("by default a generation that already has a photo keeps it",
      gens[0].wikiFile === "Something chosen by hand.jpg", gens[0].wikiFile);
    t("...and only the empty one is scanned", res.scanned === 1 && res.filled === 1, JSON.stringify(res));
    t("...and the fill cannot take the photo the other one is holding",
      gens[1].wikiFile !== gens[0].wikiFile, gens[1].wikiFile);
  }

  // ---- {all:true} re-derives, and that is how a worse photo gets replaced -
  {
    const seed = { families: { "m-mb-gla": entry([gen("X156", "Lead photo.jpg"), gen("H247", "Lead photo.jpg")]) },
                   relations: {}, __serverAvailable: true };
    const { LF } = freshLF(seed, { "Mercedes-Benz GLA": GLA });
    const res = await LF.refreshGenerationImages({ all: true });
    const gens = seed.families["m-mb-gla"].proposal.generations;
    t("all:true replaces the generic photo both generations were sharing",
      gens[0].wikiFile === "X156 photo.jpg" && gens[1].wikiFile === "H247 photo.jpg",
      gens.map(g => g.wikiFile).join(" / "));
    t("...counted as replaced, not filled", res.replaced === 2 && res.filled === 0, JSON.stringify(res));
  }

  // ---- an article with no photo for a generation must not blank it --------
  {
    const bare = "{{Infobox automobile\n| name = Thing\n}}\n'''Q1'''\n" + pad("body", 20);
    const seed = { families: { "m-thing": { status: "confirmed", sourceTitle: "Thing",
      proposal: { generations: [{ code: "Q1", wikiFile: "Kept photo.jpg" }] } } },
      relations: {}, __serverAvailable: true };
    const { LF, saved } = freshLF(seed, { "Thing": bare });
    const res = await LF.refreshGenerationImages({ all: true });
    t("a generation that finds nothing this time keeps the photo it had",
      seed.families["m-thing"].proposal.generations[0].wikiFile === "Kept photo.jpg");
    t("...and nothing is written when nothing changed", saved.length === 0 && res.replaced === 0);
  }

  // ---- an unreachable article is reported, not thrown --------------------
  {
    const seed = { families: {
      "m-mb-gla": entry([gen("X156", null)]),
      "m-gone": { status: "confirmed", sourceTitle: "No Such Article",
                  proposal: { generations: [{ code: "Z1", wikiFile: null }] } },
    }, relations: {}, __serverAvailable: true };
    const { LF } = freshLF(seed, { "Mercedes-Benz GLA": GLA });
    const res = await LF.refreshGenerationImages();
    t("a missing article is collected as a failure", res.failed.length === 1 && res.failed[0].id === "m-gone",
      JSON.stringify(res.failed));
    t("...and the other families are still done", res.filled === 1,
      seed.families["m-mb-gla"].proposal.generations[0].wikiFile);
  }

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
