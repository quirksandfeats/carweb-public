// Four more reported issues from the same batch.
//
// 1. "There are instances (like the Aston Martin Vantage nameplate) where
//    there are 2 nameplates that are exactly identical to each other. They
//    should automatically be merged if these exist."
//
// 2. "It seems that some of the cars that are nameplates are still exposing
//    the generations even when I am not selecting the make of a car company
//    nor when I am selecting a particular nameplate/model... I can see this
//    issue particularly when I select a make and then unselect it. All of the
//    make's nameplates will then remain exposed after the fact."
//
// 3. "Currently with car marks that are brand new and the LLM cannot find a
//    link, I as the user cannot enter a link after the fact. However, I
//    should be able to add a wikipedia link to it."
//
// 4. "Most of the time it uses the same picture for each generation of a
//    nameplate."
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

function freshWindow(seed, llmSeed) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  if (seed) seed(window.CARDATA);
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {}, __serverAvailable: true }, llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  window.CarWeb.boot();
  window.CarWeb.setYearRange(1900, window.CarWeb.yearRange().max);
  return window;
}

// ================= 1. the Aston Martin Vantage duplicate =================
console.log("--- a nameplate duplicated as a bare umbrella model is folded in ---");
{
  // The exact shape found in the real data: an ungrouped model carrying the
  // nameplate's general Wikipedia article (an EARLIER era of the same car),
  // beside the family built from the per-generation articles.
  const FAM = "fam-test-dup-vantage", G1 = "m-test-dup-v2005", G2 = "m-test-dup-v2018";
  const BARE = "m-test-dup-vantage", UNRELATED = "m-test-dup-other";
  const window = freshWindow(DATA => {
    const mk = { id: "mk-test-dup", type: "make", label: "TestAston", year: 1913 };
    DATA.nodes.push(mk,
      { id: FAM, type: "family", label: "Vantage", make: "TestAston", year: 2005, end: null, generations: [G1, G2] },
      { id: G1, type: "model", label: "Vantage (2005)", make: "TestAston", familyOf: FAM, year: 2005, end: 2018 },
      { id: G2, type: "model", label: "Vantage (2018)", make: "TestAston", familyOf: FAM, year: 2018, end: null },
      // Same make, same label, ungrouped, and an EARLIER era.
      { id: BARE, type: "model", label: "Vantage", make: "TestAston", year: 1972, end: 1973,
        wp: "TestAston Vantage", designers: ["Umbrella Designer"] },
      { id: UNRELATED, type: "model", label: "Vanquish", make: "TestAston", year: 2001, end: 2007 });
    DATA.links.push(
      { source: FAM, target: mk.id, type: "made" }, { source: BARE, target: mk.id, type: "made" },
      { source: UNRELATED, target: mk.id, type: "made" },
      { source: FAM, target: G1, type: "generation" }, { source: FAM, target: G2, type: "generation" });
  });
  const cw = window.CarWeb;
  const fam = cw.byId.get(FAM), bare = cw.byId.get(BARE);

  check("the umbrella model was folded into the nameplate", bare.familyOf === FAM, bare.familyOf);
  check("it's now one of the nameplate's generations", (fam.generations || []).includes(BARE), JSON.stringify(fam.generations));
  check("...and it was NOT deleted -- it keeps its own id, links and article",
    !bare.retired && bare.wp === "TestAston Vantage");
  check("generations are in chronological order, so the earlier era is first",
    fam.generations[0] === BARE, JSON.stringify(fam.generations));
  check("the nameplate's span widened back to the earlier era", fam.year === 1972, fam.year);
  check("its designer credit rolled up to the nameplate",
    (fam.designers || []).includes("Umbrella Designer"), JSON.stringify(fam.designers));
  check("the nameplate inherited the umbrella article as its own",
    fam.wp === "TestAston Vantage", fam.wp);
  check("only ONE 'TestAston Vantage' dot is visible now (the duplicate is inside it)",
    cw.nodes.filter(n => !n.retired && cw.nodeInLayer(n) && n.make === "TestAston" && n.label === "Vantage").length === 1);
  check("a genuinely different model of the same make is untouched", !cw.byId.get(UNRELATED).familyOf);

  // The guard: two families with the same name are ambiguous, not a
  // duplicate of this shape, and must be left alone.
  const w2 = freshWindow(DATA => {
    const mk = { id: "mk-test-dup2", type: "make", label: "TestTwoFam", year: 1950 };
    DATA.nodes.push(mk,
      { id: "fam-test-dup2-a", type: "family", label: "Same", make: "TestTwoFam", year: 2000, end: null, generations: [] },
      { id: "fam-test-dup2-b", type: "family", label: "Same", make: "TestTwoFam", year: 2010, end: null, generations: [] });
    DATA.links.push({ source: "fam-test-dup2-a", target: mk.id, type: "made" },
                    { source: "fam-test-dup2-b", target: mk.id, type: "made" });
  });
  check("two same-named FAMILIES are left alone (ambiguous, not this bug)",
    !w2.CarWeb.byId.get("fam-test-dup2-a").familyOf && !w2.CarWeb.byId.get("fam-test-dup2-b").familyOf);
}

// ================= 2. generations must collapse again on release =================
console.log("\n--- releasing focus collapses everything that focus expanded ---");
{
  const MK = "mk-test-rev", FAM_A = "fam-test-rev-a", A1 = "m-test-rev-a1", A2 = "m-test-rev-a2";
  const FAM_B = "fam-test-rev-b", B1 = "m-test-rev-b1", B2 = "m-test-rev-b2";
  const window = freshWindow(DATA => {
    DATA.nodes.push({ id: MK, type: "make", label: "TestRevCo", year: 1950 },
      { id: FAM_A, type: "family", label: "Ayy", make: "TestRevCo", year: 2000, end: null, generations: [A1, A2] },
      { id: A1, type: "model", label: "Ayy I", make: "TestRevCo", familyOf: FAM_A, year: 2000, end: 2010 },
      { id: A2, type: "model", label: "Ayy II", make: "TestRevCo", familyOf: FAM_A, year: 2010, end: null },
      { id: FAM_B, type: "family", label: "Bee", make: "TestRevCo", year: 2004, end: null, generations: [B1, B2] },
      { id: B1, type: "model", label: "Bee I", make: "TestRevCo", familyOf: FAM_B, year: 2004, end: 2014 },
      { id: B2, type: "model", label: "Bee II", make: "TestRevCo", familyOf: FAM_B, year: 2014, end: null });
    DATA.links.push(
      { source: FAM_A, target: MK, type: "made" }, { source: FAM_B, target: MK, type: "made" },
      { source: FAM_A, target: A1, type: "generation" }, { source: FAM_A, target: A2, type: "generation" },
      { source: FAM_B, target: B1, type: "generation" }, { source: FAM_B, target: B2, type: "generation" },
      // A generation-level relation, so focusing the make reveals BOTH
      // nameplates -- the exact situation the report describes.
      { source: A1, target: B1, type: "related" });
  });
  const cw = window.CarWeb;
  check("nothing expanded at boot", !cw.isFamilyExpanded(FAM_A) && !cw.isFamilyExpanded(FAM_B));

  cw.goto(MK);
  check("clicking the make expanded the related nameplates", cw.isFamilyExpanded(FAM_A) || cw.isFamilyExpanded(FAM_B));
  window.document.getElementById("clearfocus").onclick();
  check("releasing focus collapsed ALL of them again -- the reported bug",
    !cw.isFamilyExpanded(FAM_A) && !cw.isFamilyExpanded(FAM_B));
  check("...so no generation is left exposed", [A1, A2, B1, B2].every(id => !cw.nodeInLayer(cw.byId.get(id))));

  // Browsing car to car must not accumulate expansions either -- same bug,
  // reached by clicking on rather than by releasing.
  cw.goto(FAM_A);
  check("focusing Ayy expands it", cw.isFamilyExpanded(FAM_A));
  cw.goto(cw.byId.get("m-test-rev-b2").id);
  check("moving to another car released Ayy's expansion", !cw.isFamilyExpanded(FAM_A));

  // A nameplate the user opened deliberately is never yanked shut.
  cw.expandFamily(FAM_A);
  cw.goto(FAM_B);
  window.document.getElementById("clearfocus").onclick();
  check("a nameplate expanded deliberately beforehand survives a focus/release cycle",
    cw.isFamilyExpanded(FAM_A));
}

// ================= 3. a make can be given a Wikipedia link by hand =================
console.log("\n--- a make with no article can be given one from its own card ---");
{
  const MK = "mk-test-nolink";
  const window = freshWindow(DATA => {
    DATA.nodes.push({ id: MK, type: "make", label: "TestNoLinkCo", year: 2020, llmGenerated: true },
      { id: "m-test-nolink-car", type: "model", label: "Onlycar", make: "TestNoLinkCo", year: 2020, end: null });
    DATA.links.push({ source: "m-test-nolink-car", target: MK, type: "made" });
  });
  const cw = window.CarWeb;
  const mk = cw.byId.get(MK);
  check("fixture: the make genuinely has no article", !mk.wp);
  cw.openDetail(mk);
  // The link row moved to its own container at the very bottom of the card
  // (after the connections list) -- real user request: "I want that the
  // buttons for 'change link' and 'find it' to be at the very bottom of an
  // information card, hidden by a compacted dropdown button... to prevent
  // misclicks or mistakes."
  const block = window.document.querySelector(".dt-wplink");
  check("a make's card now offers the Wikipedia-link row at all (was: nothing)",
    !!block.querySelector(".llm-wp-row"), block.innerHTML.slice(0, 160));
  check("...with an Add link control", !!block.querySelector(".llm-wp-change"));
  check("...and a 🔎 Find it control", !!block.querySelector(".llm-wp-find"));
  // ...but both are behind a CLOSED disclosure, not sitting there to be
  // clicked by accident. The link itself stays plainly visible.
  const tools = block.querySelector("details.llm-wp-tools");
  check("...both tucked inside a disclosure", !!tools && tools.contains(block.querySelector(".llm-wp-change")));
  check("...which starts closed", tools && !tools.open);
  check("...while the article line itself stays visible", !!block.querySelector(".llm-wp-current"));
  // And the link actually lands on the node.
  window.LlmFamilies.setNodeWikiLink(MK, "TestNoLinkCo Motors", cw.nodes, { force: true });
  check("a pasted link is stamped onto the make", mk.wp === "TestNoLinkCo Motors", mk.wp);
}

// ================= 4. a distinct photo per generation =================
console.log("\n--- each generation gets its own photo, not the nameplate's lead image ---");
{
  const window = freshWindow();
  const LF = window.LlmFamilies;
  // The shape that caused the bug: every generation code is named up front in
  // the lead/infobox (so a naive "first occurrence" anchor puts them all next
  // to the lead image), with each generation's real photo further down in its
  // own section.
  const WIKITEXT = [
    "[[File:Nameplate lead photo.jpg|thumb|The nameplate]]",
    "{{Infobox automobile | production = 1979-1991 (W460), 1990-2018 (W463), 2018-present (W464) }}",
    "The nameplate has been built as the W460, the W463 and the W464.",
    "== W460 ==",
    "[[File:Gen one photo.jpg|thumb|The W460]]",
    "The W460 ran from 1979.",
    "== W463 ==",
    "[[File:Gen two photo.jpg|thumb|The W463]]",
    "The W463 replaced it.",
    "== W464 ==",
    "The W464 is current, with no photo of its own in this article.",
  ].join("\n");

  const used = new Set();
  const pick = code => {
    const f = LF.findGenerationImage(WIKITEXT, code, WIKITEXT.toLowerCase().indexOf(code.toLowerCase()), used);
    if (f) used.add(f.toLowerCase());
    return f;
  };
  const a = pick("W460"), b = pick("W463"), c = pick("W464");
  check("the first generation gets its OWN section photo, not the lead image", a === "Gen one photo.jpg", a);
  check("the second gets its own too", b === "Gen two photo.jpg", b);
  check("all picks are distinct", new Set([a, b].filter(Boolean)).size === 2, JSON.stringify([a, b]));
  check("a generation with no photo of its own gets null rather than duplicating a sibling's",
    c === null || (c !== a && c !== b), c);

  // Non-photographic files must never be chosen -- they're common in car
  // infoboxes and make a particularly bad thumbnail.
  const LOGOS = "== Zed ==\n[[File:Company logo.svg|thumb]]\n[[File:Badge icon.png|thumb]]\n[[File:Real car.jpg|thumb]]\nThe Zed.";
  check("logos/badges/svg are skipped in favour of a real photo",
    LF.findGenerationImage(LOGOS, "Zed", LOGOS.toLowerCase().indexOf("zed"), new Set()) === "Real car.jpg");
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
