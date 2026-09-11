// The "correct what's already here" features, all reported together.
//
// 1. "If a card doesn't have a wikipedia link to it... there should be an
//    option in the card itself to add a wikipedia link. For example, the Ford
//    Maverick model is in my knowledge graph but has no wikipedia link, and I
//    cannot even do an LLM search on it for some reason. However, I should be
//    able to do both an LLM search on it... or I should be able to give it a
//    wikipedia link by hand... If a wikipedia link was found by the LLM at
//    any point, then the user should have the option to change the wikipedia
//    link in case it's inaccurate. Then, if the user presses 'recheck with
//    llm' then it should recheck it with the new wikipedia link provided."
//
// 2. "in the 'Tools' Section there should also be a 'Modify Existing Car'
//    button which lets the user modify the wikipedia link or ask for a
//    particular request with the LLM, like potentially merging multiple
//    models together into one nameplate if it has not been previously
//    caught."
//
// 3. The Mercedes-Benz W211 case: a generation inherits its nameplate's
//    Wikipedia article, so reading it only ever finds the nameplate-wide
//    "related" field. "it would be actually worth checking if there exists a
//    separate wikipedia page for each of these generations, and then use that
//    wikipedia page for the LLM to read through... Additionally, the user
//    should also be able to do an LLM search on an individual generation as
//    well."
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freshWindow(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = opts.fetchImpl || (() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  if (opts.seed) opts.seed(window.CARDATA);
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {}, wpLinks: {}, merges: {}, genResearch: {}, __serverAvailable: true }, opts.llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  load("platforms.js");
  return window;
}

(async () => {
  // ============ 1. the Ford Maverick case: a linkless car with the toggle OFF ============
  console.log("--- a car with no Wikipedia link is never a dead end, toggle or not ---");
  {
    const ID = "m-test-mav-maverick";
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-mav", type: "make", label: "TestFord", year: 1903 };
        DATA.nodes.push(mk, { id: ID, type: "model", label: "Mavericky", make: "TestFord", year: 2021, end: null });
        DATA.links.push({ source: ID, target: mk.id, type: "made" });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    cw.setLlmCheck(false);          // the reported state: the toggle is OFF

    const n = cw.byId.get(ID);
    check("fixture: the car genuinely has no Wikipedia link", !n.wp);
    cw.openDetail(n);
    // The link controls moved to their own container at the very bottom of the
    // card, behind a closed disclosure -- real user request, "to prevent
    // misclicks or mistakes". Still offered, just not sitting under the cursor.
    // Two different things live in two different places now: the "no article
    // on file, paste one" prompt is part of the CHECK's own body (it's the
    // check's dead end), while the always-present link controls sit at the
    // bottom of the card behind a disclosure. Look in both.
    const block = window.document.querySelector(".dt-wplink");
    const checkBlock = window.document.querySelector(".dt-llmcheck");
    check("with the toggle OFF, the paste-a-link field is still offered (was: nothing at all)",
      !!(block.querySelector(".llm-wp-url") || checkBlock.querySelector(".llm-wp-url")),
      block.innerHTML.slice(0, 120) + " | " + checkBlock.innerHTML.slice(0, 120));
    check("a '🔎 Find it' button is offered too, so an automatic lookup can be asked for",
      !!block.querySelector(".llm-wp-find"));
    check("no dead-end 'no-wiki-link' entry was burned just to show the UI", !window.LlmFamilies.entryFor(ID));
  }

  // ============ 2. correcting a link that already exists ============
  console.log("\n--- an existing but WRONG link can be replaced, and the re-check uses the new one ---");
  {
    const ID = "m-test-relink-car";
    const WRONG = "TestRelink Wrong Article", RIGHT = "TestRelink Right Article";
    const fetched = [];
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-relink", type: "make", label: "TestRelink", year: 1950 };
        DATA.nodes.push(mk, { id: ID, type: "model", label: "Carly", make: "TestRelink", year: 2000, end: null, wp: WRONG });
        DATA.links.push({ source: ID, target: mk.id, type: "made" });
      },
      fetchImpl: (url, opts) => {
        const u = String(url);
        if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
          const m = decodeURIComponent(u).match(/page=([^&]+)/);
          if (m) fetched.push(m[1].replace(/\+/g, " "));
          return Promise.resolve({ ok: true, json: async () => ({ parse: { title: m ? m[1].replace(/\+/g, " ") : "x", wikitext: { "*": "Carly is a car. Only one generation was ever made." } } }) });
        }
        if (u === "/api/llm/chat") {
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hasMultipleGenerations: false, generations: [] }) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    cw.setLlmCheck(true);
    const n = cw.byId.get(ID);
    cw.openDetail(n);
    await sleep(60);

    const entryBefore = window.LlmFamilies.entryFor(ID);
    check("fixture: a real verdict exists, derived from the WRONG article",
      entryBefore && entryBefore.sourceTitle === WRONG, entryBefore && entryBefore.sourceTitle);

    const block = window.document.querySelector(".dt-wplink");
    check("the current link is shown on the card", /TestRelink Wrong Article/.test(block.textContent), block.textContent.slice(0, 160));
    const changeBtn = block.querySelector(".llm-wp-change");
    check("a 'Change link' control is offered even though a link already exists", !!changeBtn);
    changeBtn.onclick();
    const input = block.querySelector(".llm-wp-url");
    const useBtn = block.querySelector(".llm-wp-use");
    check("clicking it reveals the paste field", !!input && !!useBtn);

    fetched.length = 0;
    input.value = "https://en.wikipedia.org/wiki/" + encodeURIComponent(RIGHT.replace(/ /g, "_"));
    useBtn.onclick();
    await sleep(80);

    check("node.wp was replaced with the corrected article", n.wp === RIGHT, n.wp);
    const entryAfter = window.LlmFamilies.entryFor(ID);
    check("the stale verdict from the old article was NOT reused -- a real re-check ran against the new one",
      entryAfter && entryAfter.sourceTitle === RIGHT, entryAfter && entryAfter.sourceTitle);
    check("...and the new article is what actually got fetched", fetched.some(t => t.replace(/_/g, " ") === RIGHT), JSON.stringify(fetched));
  }

  // ============ 3. merging standalone models into one nameplate ============
  console.log("\n--- merging several models into one nameplate (Tools -> Modify Existing Car) ---");
  {
    const PRIMARY = "m-test-merge-crown", M2 = "m-test-merge-majesta", M3 = "m-test-merge-athlete";
    const OTHER_MAKE = "m-test-merge-otherco";
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-merge", type: "make", label: "TestToyota", year: 1937 };
        const mk2 = { id: "mk-test-merge2", type: "make", label: "TestOther", year: 1950 };
        DATA.nodes.push(mk, mk2,
          { id: PRIMARY, type: "model", label: "Crowny", make: "TestToyota", year: 1955, end: 1971, designers: ["Aa Bb"] },
          { id: M2, type: "model", label: "Crowny Majesta", make: "TestToyota", year: 1991, end: 2018 },
          { id: M3, type: "model", label: "Crowny Athlete", make: "TestToyota", year: 1999, end: 2012 },
          { id: OTHER_MAKE, type: "model", label: "Elsewhere", make: "TestOther", year: 2000, end: null });
        DATA.links.push(
          { source: PRIMARY, target: mk.id, type: "made" }, { source: M2, target: mk.id, type: "made" },
          { source: M3, target: mk.id, type: "made" }, { source: OTHER_MAKE, target: mk2.id, type: "made" });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    const LF = window.LlmFamilies;

    const primary = cw.byId.get(PRIMARY);
    check("fixture: all three start as separate plain models", primary.type === "model" &&
      cw.byId.get(M2).type === "model" && cw.byId.get(M3).type === "model");


    // mergeModelsIntoNameplate is a pure data operation on the nodes/links
    // arrays -- splicing the result into app.js's own byId/adj indexes is the
    // panel's job (initModifyCarPanel calls spliceIntoIndexes), so look the
    // freshly-minted stand-in node up out of the array directly here.
    const findNode = id => cw.nodes.find(n => n.id === id);
    const res = LF.mergeModelsIntoNameplate(PRIMARY, [M2, M3], cw.nodes, cw.links);
    check("the merge reports success", res.ok, JSON.stringify(res));
    check("the primary became a nameplate, keeping its own id (so existing links still resolve)",
      primary.type === "family" && cw.byId.get(PRIMARY) === primary);
    check("it has 3 generations -- the two merged in, plus a stand-in for itself",
      primary.generations && primary.generations.length === 3, JSON.stringify(primary.generations));
    check("the merged models were adopted IN PLACE (familyOf set), not re-minted as copies",
      findNode(M2).familyOf === PRIMARY && findNode(M3).familyOf === PRIMARY);
    check("generations are ordered chronologically", (() => {
      const ys = primary.generations.map(id => findNode(id).year);
      return ys.every((y, i) => i === 0 || ys[i - 1] <= y);
    })(), JSON.stringify(primary.generations.map(id => findNode(id).year)));
    check("the primary's own year span now covers the whole nameplate", primary.year === 1955 && primary.end === 2018,
      `${primary.year}-${primary.end}`);
    check("the primary's own designer credit survived onto its generation stand-in",
      primary.generations.some(id => (findNode(id).designers || []).includes("Aa Bb")));
    check("the merge is persisted so it replays on the next boot", LF.allMerges().some(m => m.id === PRIMARY));

    // Guard rail: a car from a DIFFERENT manufacturer is never a generation
    // of this nameplate. A same-platform car wearing another badge is a
    // `related` link; folding one in here would misrepresent it permanently.
    const genCountBefore = primary.generations.length;
    const bad = LF.mergeModelsIntoNameplate(PRIMARY, [OTHER_MAKE], cw.nodes, cw.links);
    check("merging in a car from a different make is refused", !bad.ok, JSON.stringify(bad));
    check("...and the existing nameplate is left exactly as it was",
      primary.generations.length === genCountBefore && !findNode(OTHER_MAKE).familyOf, primary.generations.length);

    // Undo must genuinely revert -- that's the whole reason the merge adopts
    // nodes in place rather than minting copies.
    await LF.undoMerge(PRIMARY);
    check("undoing removes the persisted record", !LF.allMerges().some(m => m.id === PRIMARY));
  }

  // ============ 4. researching one generation against its OWN article ============
  console.log("\n--- generation-level research picks the more specific article (the W211 case) ---");
  {
    const FAM = "fam-test-w211-e", G = "m-test-w211-gen";
    const NAMEPLATE_ARTICLE = "TestMercedes E-Class";
    const GEN_ARTICLE = "TestMercedes W211";
    const asked = [];
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-w211", type: "make", label: "TestMercedes", year: 1926 };
        DATA.nodes.push(mk,
          { id: FAM, type: "family", label: "E-Class", make: "TestMercedes", wp: NAMEPLATE_ARTICLE, year: 1993, end: null, generations: [G] },
          // The generation inherits the NAMEPLATE's article -- exactly what
          // applyConfirmed does (`wp: (dup && dup.wp) || orig.wp`), and
          // exactly why the specific related cars were never found.
          { id: G, type: "model", label: "E-Class (W211)", make: "TestMercedes", familyOf: FAM, wp: NAMEPLATE_ARTICLE, year: 2002, end: 2009 },
          { id: "m-test-w211-clk", type: "model", label: "CLK-Class (C209)", make: "TestMercedes", year: 2002, end: 2010 },
          { id: "m-test-w211-cls", type: "model", label: "CLS-Class (C219)", make: "TestMercedes", year: 2004, end: 2010 });
        DATA.links.push(
          { source: FAM, target: mk.id, type: "made" },
          { source: "m-test-w211-clk", target: mk.id, type: "made" },
          { source: "m-test-w211-cls", target: mk.id, type: "made" },
          { source: FAM, target: G, type: "generation" });
      },
      fetchImpl: (url, opts) => {
        const u = String(url);
        if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
          const m = decodeURIComponent(u).match(/page=([^&]+)/);
          const title = m ? m[1].replace(/\+/g, " ").replace(/_/g, " ") : "";
          asked.push(title);
          // Only these two titles exist. Crucially they are DIFFERENT
          // articles, and only the generation's own one names the siblings.
          if (title === GEN_ARTICLE) {
            return Promise.resolve({ ok: true, json: async () => ({ parse: { title: GEN_ARTICLE, wikitext: { "*":
              "{{Infobox automobile\n| related = CLK-Class (C209), CLS-Class (C219)\n}}\n" +
              "The W211 shares its platform with the CLK-Class (C209) and the CLS-Class (C219). " +
              "It was designed by Steve Mattin." } } }) });
          }
          if (title === NAMEPLATE_ARTICLE) {
            return Promise.resolve({ ok: true, json: async () => ({ parse: { title: NAMEPLATE_ARTICLE, wikitext: { "*":
              "{{Infobox automobile\n| related = C-Class\n}}\nThe E-Class is an executive car." } } }) });
          }
          return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
        }
        if (u === "/api/llm/chat") {
          const body = JSON.parse(opts.body);
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
            hasMultipleGenerations: false,
            generations: [{
              code: "W211", yearStart: 2002, yearEnd: 2009,
              designers: ["Steve Mattin"], engineers: [],
              sharedPlatforms: ["CLK-Class (C209)", "CLS-Class (C219)"],
            }],
          }) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    const LF = window.LlmFamilies;
    const gen = cw.byId.get(G);

    check("fixture: the generation starts out pointing at the NAMEPLATE's article", gen.wp === NAMEPLATE_ARTICLE);
    check("a generation is eligible for research (and not for the two nameplate-level checks)",
      LF.isEligibleForGenerationResearch(gen) && !LF.isEligible(gen) && !LF.isEligibleForRecheck(gen));

    cw.openDetail(gen);
    const btn = window.document.querySelector(".llm-genresearch-btn");
    check("a '🔎 Research this generation' button is offered on a generation's card", !!btn);
    btn.onclick();
    await sleep(160);

    check("the generation's link was upgraded to its OWN dedicated article", gen.wp === GEN_ARTICLE, gen.wp);
    check("...and that article really was fetched", asked.includes(GEN_ARTICLE), JSON.stringify(asked));
    const entry = LF.genResearchEntryFor(G);
    check("a research entry was recorded", entry && entry.status === "done", entry && (entry.status + " " + entry.error));
    check("the related cars named ONLY in the generation's own article were found",
      entry && entry.relatedTexts && entry.relatedTexts.length === 2, entry && JSON.stringify(entry.relatedTexts));
    check("the designer credited in that article was added to the generation",
      (gen.designers || []).includes("Steve Mattin"), JSON.stringify(gen.designers));
    check("...and rolled up to the nameplate too, so it still shows while collapsed",
      (cw.byId.get(FAM).designers || []).includes("Steve Mattin"));
    const personLink = cw.links.some(l => l.type === "designed" && !l.retired &&
      [l.sn, l.tn].some(e => e && e.id === G) && [l.sn, l.tn].some(e => e && e.label === "Steve Mattin"));
    check("a real graph link to that designer exists, not just text", personLink);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
