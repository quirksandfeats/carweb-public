// Real user request: findMatchingNameplate's deterministic string matching
// (exact/loose substring overlap) can miss a genuine duplicate whenever
// Wikipedia's wording differs enough from the graph's own stored label --
// different chassis-code notation, a translated/regional name, an
// abbreviation the curated label doesn't use, etc. Rather than trust a
// regex-shaped guess (or the absence of one) as the final word, checkNode
// now runs an extra LOCAL LLM "sanity check" pass (llm_families.js's
// annotateSharedPlatformMatches/verifySharedPlatformMention/askDuplicateCheck)
// over every shared-platform/rebadge mention before the proposal is ever
// applied to the graph: given the mention text and every plausible existing
// candidate (same make, or already a loose substring hit), a SEPARATE local
// LLM call decides whether it's actually one of them. This test mocks BOTH
// Ollama calls a real check makes -- the main generation-extraction call,
// and the new duplicate-check call -- and proves two things end to end:
//
//   Scenario A: a mention worded so differently from the existing node's
//   label ("Vexil2" vs. "Vexil II") that the deterministic matcher can only
//   find a coarse FAMILY-level loose hit, not the specific generation --
//   the LLM sanity check correctly points at the exact existing generation
//   node with HIGH confidence, and resolveOnePlatformMention auto-CONFIRMS
//   the relation straight away (real user request: "feel free to
//   automatically approve the sanity checks in the background if the LLM
//   can safely determine that a match can be made... unless the LLM is
//   genuinely not sure" -- a high-confidence sanity-check verdict is now
//   trusted the same as an exact deterministic match, applied with no
//   Yes/No box ever shown).
//
//   Scenario B: the sanity check can only pin down the FAMILY (not which
//   specific generation) -- proves the coarse nameplate<->nameplate
//   fallback link still gets added in this case (previously, an ambiguous/
//   loose match here was silently dropped entirely -- see
//   resolveOnePlatformMention's own comment on `found.llmVerified`).
//
//   Scenario C: same shape as scenario A (sanity check resolves onto a
//   specific existing generation), but with LOW confidence -- proves a
//   genuinely uncertain sanity-check verdict still goes through ordinary
//   human review (status "provisional"), exactly as every loose match
//   always has -- only a HIGH-confidence verdict skips review now.
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freshWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("d3.min.js");
  loadScript("data.js");
  return window;
}

// ---------- Scenario A: sanity check resolves onto a specific EXISTING generation ----------
{
  const window = freshWindow();
  const NAMEPLATE_ID = "m-test-sanity-qzyphron";
  const FAM_ID = "fam-test-sanity-zynqora", GEN_ID = "m-test-sanity-zynqora-vexil2";

  const WIKITEXT = "{{Infobox automobile\n| name = TestQzk Qzyphron\n| production = 2015-2021\n}}\n" +
    "The TestQzk Qzyphron shares its platform with the TestQzk Zynqora Vexil2.";
  let genCallMessages = null, dupCallMessages = null;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const isDupCheck = body.messages[0].content.startsWith("You check whether a mentioned car");
      if (isDupCheck) {
        dupCallMessages = body.messages;
        // The candidate list should include the real Zynqora (Vexil2) generation
        // -- reply with ITS id, even though its real label ("Vexil II") doesn't
        // textually match the mention ("Vexil2") at all -- exactly the
        // formatting-mismatch case a plain substring match can't bridge.
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          matchId: GEN_ID, confidence: "high", reason: "Vexil2 and Vexil II both refer to the second-generation Zynqora, just different notations for the same generation",
        }) } }] }) });
      }
      genCallMessages = body.messages;
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestQzk Qzyphron", yearStart: 2015, yearEnd: 2021, designers: [], engineers: [],
          sharedPlatforms: ["TestQzk Zynqora Vexil2"],
        }],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestQzk");
  if (!mk) { mk = { id: "mk-test-sanity-qzk", type: "make", label: "TestQzk", year: 1950 }; DATA.nodes.push(mk); }
  const nameplate = { id: NAMEPLATE_ID, type: "model", label: "Qzyphron", make: "TestQzk", wp: "TestQzk Qzyphron", year: 2015, end: 2021 };
  const fam = { id: FAM_ID, type: "family", label: "Zynqora", make: "TestQzk", year: 2005, end: null,
    designers: [], engineers: [], generations: [GEN_ID] };
  const gen = { id: GEN_ID, type: "model", label: "Zynqora (Vexil II)", make: "TestQzk", year: 2012, end: 2018, familyOf: FAM_ID };
  DATA.nodes.push(nameplate, fam, gen);
  DATA.links.push(
    { source: NAMEPLATE_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: GEN_ID, type: "generation" },
  );

  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  window.CarWeb.boot();
  const cw = window.CarWeb;
  cw.setYearRange(1900, cw.yearRange().max);
  cw.setLlmCheck(true);

  // Precondition: prove the deterministic matcher alone (no sanity check)
  // would NOT resolve this mention onto the specific generation -- the
  // whole point of this scenario is that only the LLM sanity check bridges it.
  {
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
    const key = norm("TestQzk Zynqora Vexil2");
    const genLabelNorm = norm("Zynqora (Vexil II)");
    check("precondition: deterministic substring match does NOT find the specific generation (formatting differs)",
      !key.includes(genLabelNorm) && !genLabelNorm.includes(key));
  }

  cw.openDetail(nameplate);

  (async () => {
    await sleep(80);
    check("the main generation-extraction call ran", !!genCallMessages);
    check("the duplicate sanity-check call ALSO ran (deterministic match was only a loose family-level hit, not exact)", !!dupCallMessages);
    check("the duplicate-check candidate list included the real existing generation node's id",
      dupCallMessages && dupCallMessages[1].content.includes(GEN_ID), dupCallMessages && dupCallMessages[1].content);

    // Real behavior change (task #106, multi-generation-pair support): this
    // key is scoped to the two specific generation ids actually involved
    // (this nameplate's own single generation, and the real GEN_ID the
    // sanity check found) rather than the coarser whole-family id, so a
    // different generation independently finding its own platform partner
    // gets its own entry instead of colliding with this one.
    const relKey = [NAMEPLATE_ID, GEN_ID].sort().join("|") + "|platform";
    const rel = window.LlmFamilies.relationEntryFor(relKey);
    check("a relation entry exists, pointing at the real family", !!rel, rel);
    check("status is 'confirmed' -- a HIGH-confidence sanity-check verdict is now auto-approved in the background, no review step shown",
      rel && rel.status === "confirmed", rel);
    check("decidedAt was stamped immediately, same as any other auto-confirmed match", rel && !!rel.decidedAt, rel && rel.decidedAt);
    check("genIdB is the REAL existing generation node the sanity check found -- not a new/duplicate one", rel && rel.genIdB === GEN_ID, rel);
    check("reason mentions this was auto-approved plus the LLM sanity check's own explanation",
      rel && /auto-approved/i.test(rel.reason || "") && /vexil2 and vexil ii/i.test(rel.reason || ""), rel && rel.reason);

    // The real graph link itself should already exist too -- applyResolvedRelations
    // wires a "confirmed" entry in immediately, no separate Yes/No click needed.
    const realLink = cw.links.find(l => l.type === "platform" && l.llmResolved &&
      ((l.sn === nameplate && l.tn === gen) || (l.sn === gen && l.tn === nameplate)));
    check("the real generation<->generation link was applied immediately (no pending review)", !!realLink, realLink);

    const ghost = cw.nodes.find(n => /zynqora/i.test(n.label || "") && n.id !== GEN_ID && n.id !== FAM_ID);
    check("no duplicate/ghost node was minted for this mention", !ghost, ghost);

    console.log("\n--- scenario A done ---");
    runScenarioB();
  })();
}

// ---------- Scenario B: sanity check only pins down the FAMILY (ambiguous generation) ----------
function runScenarioB() {
  const window = freshWindow();
  const NAMEPLATE_ID = "m-test-sanity-xilbrant";
  const FAM_ID = "fam-test-sanity-qonteva", G1_ID = "m-test-sanity-qonteva-zorvex", G2_ID = "m-test-sanity-qonteva-vloxen";

  const WIKITEXT = "{{Infobox automobile\n| name = TestQzk Xilbrant\n| production = 2018-2023\n}}\n" +
    "The TestQzk Xilbrant is a rebadge of the TestQzk Qonteva Frendal.";
  let dupCallMessages = null;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const isDupCheck = body.messages[0].content.startsWith("You check whether a mentioned car");
      if (isDupCheck) {
        dupCallMessages = body.messages;
        // The LLM is confident this IS the Qonteva family, but can't tell
        // which of its two generations -- returns the FAMILY's own id.
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          matchId: FAM_ID, confidence: "low", reason: "definitely a Qonteva, but the text doesn't say which generation",
        }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestQzk Xilbrant", yearStart: 2005, yearEnd: 2023, designers: [], engineers: [],
          sharedPlatforms: ["TestQzk Qonteva Frendal"],
        }],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestQzk");
  if (!mk) { mk = { id: "mk-test-sanity-qzk", type: "make", label: "TestQzk", year: 1950 }; DATA.nodes.push(mk); }
  const nameplate = { id: NAMEPLATE_ID, type: "model", label: "Xilbrant", make: "TestQzk", wp: "TestQzk Xilbrant", year: 2005, end: 2023 };
  const fam = { id: FAM_ID, type: "family", label: "Qonteva", make: "TestQzk", year: 2000, end: null,
    designers: [], engineers: [], generations: [G1_ID, G2_ID] };
  const g1 = { id: G1_ID, type: "model", label: "Qonteva (Zorvex)", make: "TestQzk", year: 2000, end: 2010, familyOf: FAM_ID };
  const g2 = { id: G2_ID, type: "model", label: "Qonteva (Vloxen)", make: "TestQzk", year: 2010, end: null, familyOf: FAM_ID };
  DATA.nodes.push(nameplate, fam, g1, g2);
  DATA.links.push(
    { source: NAMEPLATE_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: G1_ID, type: "generation" },
    { source: FAM_ID, target: G2_ID, type: "generation" },
  );

  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  window.CarWeb.boot();
  const cw = window.CarWeb;
  cw.setYearRange(1900, cw.yearRange().max);
  cw.setLlmCheck(true);
  cw.openDetail(nameplate);

  (async () => {
    await sleep(80);
    check("the duplicate sanity-check call ran for scenario B too", !!dupCallMessages);

    const already = cw.links.find(l => l.type === "platform" &&
      ((l.sn === nameplate && l.tn === fam) || (l.sn === fam && l.tn === nameplate)));
    check("a coarse nameplate<->family fallback link was added even though the specific generation is ambiguous " +
      "(previously an ambiguous loose match here would be silently dropped -- found.llmVerified now overrides that)",
      !!already, already);
    check("the fallback link is flagged as LLM-verified", already && already.llmVerifiedDuplicate === true, already);

    const ghost = cw.nodes.find(n => /qonteva/i.test(n.label || "") && n.id !== G1_ID && n.id !== G2_ID && n.id !== FAM_ID);
    check("no duplicate/ghost node was minted", !ghost, ghost);

    console.log("\n--- scenario B done ---");
    runScenarioC();
  })();
}

// ---------- Scenario C: same shape as A, but LOW confidence -- must stay provisional ----------
function runScenarioC() {
  const window = freshWindow();
  const NAMEPLATE_ID = "m-test-sanity-wrivont";
  const FAM_ID = "fam-test-sanity-drazuun", GEN_ID = "m-test-sanity-drazuun-fex3";

  const WIKITEXT = "{{Infobox automobile\n| name = TestQzk Wrivont\n| production = 2016-2022\n}}\n" +
    "The TestQzk Wrivont shares its platform with the TestQzk Drazuun Fex3.";
  let dupCallMessages = null;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const isDupCheck = body.messages[0].content.startsWith("You check whether a mentioned car");
      if (isDupCheck) {
        dupCallMessages = body.messages;
        // Same shape as scenario A (resolves onto a specific existing
        // generation), but this time the LLM itself says it's LOW
        // confidence -- must NOT auto-confirm.
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          matchId: GEN_ID, confidence: "low", reason: "probably the same car, but the naming is unusual enough that I'm not fully sure",
        }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestQzk Wrivont", yearStart: 2016, yearEnd: 2022, designers: [], engineers: [],
          sharedPlatforms: ["TestQzk Drazuun Fex3"],
        }],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestQzk");
  if (!mk) { mk = { id: "mk-test-sanity-qzk", type: "make", label: "TestQzk", year: 1950 }; DATA.nodes.push(mk); }
  const nameplate = { id: NAMEPLATE_ID, type: "model", label: "Wrivont", make: "TestQzk", wp: "TestQzk Wrivont", year: 2016, end: 2022 };
  const fam = { id: FAM_ID, type: "family", label: "Drazuun", make: "TestQzk", year: 2005, end: null,
    designers: [], engineers: [], generations: [GEN_ID] };
  const gen = { id: GEN_ID, type: "model", label: "Drazuun (Fex III)", make: "TestQzk", year: 2013, end: 2019, familyOf: FAM_ID };
  DATA.nodes.push(nameplate, fam, gen);
  DATA.links.push(
    { source: NAMEPLATE_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: GEN_ID, type: "generation" },
  );

  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  window.CarWeb.boot();
  const cw = window.CarWeb;
  cw.setYearRange(1900, cw.yearRange().max);
  cw.setLlmCheck(true);
  cw.openDetail(nameplate);

  (async () => {
    await sleep(80);
    check("the duplicate sanity-check call ran for scenario C too", !!dupCallMessages);

    const relKey = [NAMEPLATE_ID, GEN_ID].sort().join("|") + "|platform";
    const rel = window.LlmFamilies.relationEntryFor(relKey);
    check("a relation entry exists", !!rel, rel);
    check("status stays 'provisional' -- a LOW-confidence sanity-check verdict still always needs human review, never auto-confirmed",
      rel && rel.status === "provisional", rel);
    check("reason still mentions the LLM sanity check but asks for verification, not 'auto-approved'",
      rel && /flagged by the local llm sanity check/i.test(rel.reason || "") && !/auto-approved/i.test(rel.reason || ""), rel && rel.reason);

    console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
    process.exit(fails === 0 ? 0 : 1);
  })();
}
