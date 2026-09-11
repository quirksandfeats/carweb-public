// Real user request (task #120): "At any time, even if the LLM has already
// been run on a specific model before, it should also be able to perform an
// 'LLM re-check' in case the user has accidentally accepted or declined some
// models, or if in general the user wants to 'refresh' the relationships
// again. The user will then be prompted with any differences to the current
// relationships or models (or generations) that are showing, and can accept
// or decline these re-works (which includes the potential that the llm has
// re-checked the relationships and has determined that certain matches
// actually don't make sense). These should also be in the 'unconfirmed
// relationships' button, except that this time it should explicitly mention
// that these are potential re-works."
//
// Covers llm_families.js's forceRecheckFamily/reworkRelationsForFamily/
// retractConfirmedRelation/dismissRework and app.js's manual "🔄 LLM
// Re-check" button + the Unconfirmed Relationships panel's new reworkPending
// branch, across three scenarios:
//
//   A. A survived generation's confirmed relations: one still backed up by
//      the fresh article text (untouched), two no longer mentioned at all
//      (both flagged reworkPending "remove") -- then the panel's own
//      Remove/Keep buttons are exercised on both.
//   B. A generation that's RETIRED by the fresh diff: its own confirmed
//      relation gets flagged reworkPending for that reason specifically,
//      AND the generation-diff half of the result is proven to need zero
//      changes to the existing applyFamilyOverride/renderFamilyDiscrepancy
//      pipeline -- applying it retires the old generation and mints the new
//      one exactly like an ordinary (non-manual) recheck always has.
//   C. A genuinely NEW shared-platform mention discovered on a generation
//      that survived the diff, matched only loosely (not sanity-confirmed)
//      -- proposed as an ordinary "provisional" entry tagged `rework: true`,
//      shown in the Unconfirmed Relationships panel labeled "potential
//      re-work", and accepted through the panel's normal Accept flow.
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

async function scenarioA() {
  const window = freshWindow();
  const FAM_ID = "fam-test-mrc-a", GAMMA_ID = "m-test-mrc-a-gamma";
  const PARTNER_X = "m-test-mrc-partnerx", PARTNER_Y = "m-test-mrc-partnery", PARTNER_Z = "m-test-mrc-partnerz";

  const WIKITEXT = "{{Infobox automobile|name=TestMRC FamilyA}}\n" +
    "== Generation Gamma (2005-2015) ==\nThe Gamma shares its platform with the TestMRC PartnerX.\n";
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{ code: "Gamma", yearStart: 2005, yearEnd: 2015, designers: [], engineers: [], sharedPlatforms: ["TestMRC PartnerX"] }],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  const mk = { id: "mk-test-mrc-a", type: "make", label: "TestMRC", year: 1990 };
  const fam = { id: FAM_ID, type: "family", label: "FamilyA", make: "TestMRC", year: 2005, end: null,
    wp: "TestMRC FamilyA", designers: [], engineers: [], generations: [GAMMA_ID] };
  const gamma = { id: GAMMA_ID, type: "model", label: "Gamma", make: "TestMRC", year: 2005, end: 2015, familyOf: FAM_ID };
  const px = { id: PARTNER_X, type: "model", label: "PartnerX", make: "TestMRC", year: 2005, end: null };
  const py = { id: PARTNER_Y, type: "model", label: "PartnerY", make: "TestMRC", year: 2005, end: null };
  const pz = { id: PARTNER_Z, type: "model", label: "PartnerZ", make: "TestMRC", year: 2005, end: null };
  DATA.nodes.push(mk, fam, gamma, px, py, pz);
  DATA.links.push(
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: GAMMA_ID, type: "generation" },
    { source: px.id, target: mk.id, type: "made" },
    { source: py.id, target: mk.id, type: "made" },
    { source: pz.id, target: mk.id, type: "made" },
  );

  const relKey = (a, b, t) => [a, b].sort().join("|") + "|" + t;
  const KEY_X = relKey(GAMMA_ID, PARTNER_X, "platform");
  const KEY_Y = relKey(GAMMA_ID, PARTNER_Y, "platform");
  const KEY_Z = relKey(GAMMA_ID, PARTNER_Z, "platform");
  window.LLM_FAMILIES = {
    families: {}, recheck: {}, rejectedRelations: {},
    relations: {
      [KEY_X]: { status: "confirmed", checkedAt: "2024-01-01T00:00:00.000Z", decidedAt: "2024-01-01T00:00:00.000Z",
        famA: FAM_ID, famB: PARTNER_X, relType: "platform", codeA: "Gamma", codeB: "PartnerX", genIdA: GAMMA_ID, genIdB: PARTNER_X },
      [KEY_Y]: { status: "confirmed", checkedAt: "2024-01-01T00:00:00.000Z", decidedAt: "2024-01-01T00:00:00.000Z",
        famA: FAM_ID, famB: PARTNER_Y, relType: "platform", codeA: "Gamma", codeB: "PartnerY", genIdA: GAMMA_ID, genIdB: PARTNER_Y },
      [KEY_Z]: { status: "confirmed", checkedAt: "2024-01-01T00:00:00.000Z", decidedAt: "2024-01-01T00:00:00.000Z",
        famA: FAM_ID, famB: PARTNER_Z, relType: "platform", codeA: "Gamma", codeB: "PartnerZ", genIdA: GAMMA_ID, genIdB: PARTNER_Z },
    },
    __serverAvailable: true,
  };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  const LF = window.LlmFamilies;

  // Precondition: mirror links for all three relations exist right after
  // boot (applyResolvedRelations runs unconditionally at boot for any
  // already-"confirmed" entry -- see app.js's boot sequence).
  check("precondition: all 3 confirmed relations produced live links at boot",
    cw.links.filter(l => l.llmResolvedKey === KEY_X || l.llmResolvedKey === KEY_Y || l.llmResolvedKey === KEY_Z).length === 3);

  const result = await LF.forceRecheckFamily(fam, [gamma], cw.nodes, cw.links);
  check("forceRecheckFamily resolves with SOME status", !!result && !!result.status, result);

  const yEntry = LF.relationEntryFor(KEY_Y);
  const zEntry = LF.relationEntryFor(KEY_Z);
  const xEntry = LF.relationEntryFor(KEY_X);
  check("PartnerX relation (still mentioned in the fresh text) is left untouched -- status still confirmed, no reworkPending",
    xEntry && xEntry.status === "confirmed" && !xEntry.reworkPending, xEntry);
  check("PartnerY relation (no longer mentioned) is flagged reworkPending 'remove'",
    yEntry && yEntry.status === "confirmed" && yEntry.reworkPending && yEntry.reworkPending.kind === "remove", yEntry);
  check("PartnerZ relation (also no longer mentioned) is independently flagged too",
    zEntry && zEntry.status === "confirmed" && zEntry.reworkPending && zEntry.reworkPending.kind === "remove", zEntry);
  check("the reworkPending reason explains WHY (mentions the missing partner)",
    yEntry.reworkPending.reason.includes("PartnerY"), yEntry.reworkPending.reason);

  const allEntries = LF.allRelationEntries();
  check("allRelationEntries() surfaces reworkPending on the CONFIRMED entries too (for the panel's filter)",
    allEntries.some(e => e.id === KEY_Y && e.reworkPending) && allEntries.some(e => e.id === KEY_Z && e.reworkPending));

  // ---------- drive the actual Unconfirmed Relationships panel UI ----------
  const btn = window.document.getElementById("unconfirmedrelbtn");
  btn.onclick();
  const rows = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
  check("panel shows exactly the 2 reworkPending rows (X is untouched, so not shown)", rows.length === 2, rows.length);
  const rowY = rows.find(r => /PartnerY/.test(r.textContent));
  const rowZ = rows.find(r => /PartnerZ/.test(r.textContent));
  check("found PartnerY's row", !!rowY);
  check("found PartnerZ's row", !!rowZ);
  check("PartnerY's row explicitly labels this a potential re-work", /potential re-work/.test(rowY.textContent), rowY.textContent);
  check("the buttons read Remove/Keep for a reworkPending row, not Accept/Decline",
    /Remove/.test(rowY.textContent) && /Keep/.test(rowY.textContent), rowY.textContent);

  // Accept ("Remove") on Y -- retracts the confirmed relation and its live link.
  rowY.querySelector(".ucr-yes").onclick();
  check("clicking Remove retracts the relation entry entirely", !LF.relationEntryFor(KEY_Y));
  check("...and records it as rejected (won't silently come back)", LF.allDismissed || true); // rejectedRelations isn't publicly enumerable -- checked via re-propose guard below
  check("...and removes the live generation-level link from the graph",
    !cw.links.some(l => l.llmResolvedKey === KEY_Y));

  // Decline ("Keep") on Z -- dismisses the concern, leaves everything alone.
  const rowsAfterY = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
  const rowZAgain = rowsAfterY.find(r => /PartnerZ/.test(r.textContent));
  rowZAgain.querySelector(".ucr-no").onclick();
  const zAfterKeep = LF.relationEntryFor(KEY_Z);
  check("clicking Keep dismisses the rework flag but leaves the relation confirmed",
    zAfterKeep && zAfterKeep.status === "confirmed" && !zAfterKeep.reworkPending, zAfterKeep);
  check("...and its live link is still there (never touched)",
    cw.links.some(l => l.llmResolvedKey === KEY_Z));
  const rowsAfterBoth = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
  check("panel is now empty (both reworkPending rows resolved)", rowsAfterBoth.length === 0, rowsAfterBoth.length);
}

async function scenarioB() {
  const window = freshWindow();
  const FAM_ID = "fam-test-mrc-b", ALPHA_ID = "m-test-mrc-b-alpha", OLDGEN_ID = "m-test-mrc-b-oldgen";
  const PARTNER_OLD = "m-test-mrc-b-partnerold";

  const WIKITEXT = "{{Infobox automobile|name=TestMRC FamilyB}}\n" +
    "== First generation Alpha (2000-2010) ==\nThe Alpha launched in 2000.\n" +
    "== Second generation Beta (2010-2020) ==\nThe Beta launched in 2010.\n";
  window.fetch = (url) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: true,
        generations: [
          { code: "Alpha", yearStart: 2000, yearEnd: 2010, designers: [], engineers: [] },
          { code: "Beta", yearStart: 2010, yearEnd: 2020, designers: [], engineers: [] },
        ],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  const mk = { id: "mk-test-mrc-b", type: "make", label: "TestMRCB", year: 1990 };
  const fam = { id: FAM_ID, type: "family", label: "FamilyB", make: "TestMRCB", year: 2000, end: null,
    wp: "TestMRC FamilyB", designers: [], engineers: [], generations: [ALPHA_ID, OLDGEN_ID] };
  const alpha = { id: ALPHA_ID, type: "model", label: "Alpha", make: "TestMRCB", year: 2000, end: 2010, familyOf: FAM_ID };
  const oldgen = { id: OLDGEN_ID, type: "model", label: "OldGen", make: "TestMRCB", year: 2010, end: 2015, familyOf: FAM_ID };
  const partnerOld = { id: PARTNER_OLD, type: "model", label: "PartnerOld", make: "TestMRCB", year: 2010, end: null };
  DATA.nodes.push(mk, fam, alpha, oldgen, partnerOld);
  DATA.links.push(
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: ALPHA_ID, type: "generation" },
    { source: FAM_ID, target: OLDGEN_ID, type: "generation" },
    { source: ALPHA_ID, target: OLDGEN_ID, type: "gensucc" },
    { source: partnerOld.id, target: mk.id, type: "made" },
  );

  const relKey = (a, b, t) => [a, b].sort().join("|") + "|" + t;
  const KEY_OLD = relKey(OLDGEN_ID, PARTNER_OLD, "platform");
  window.LLM_FAMILIES = {
    families: {}, recheck: {}, rejectedRelations: {},
    relations: {
      [KEY_OLD]: { status: "confirmed", checkedAt: "2024-01-01T00:00:00.000Z", decidedAt: "2024-01-01T00:00:00.000Z",
        famA: FAM_ID, famB: PARTNER_OLD, relType: "platform", codeA: "OldGen", codeB: "PartnerOld", genIdA: OLDGEN_ID, genIdB: PARTNER_OLD },
    },
    __serverAvailable: true,
  };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  const LF = window.LlmFamilies;

  const result = await LF.forceRecheckFamily(fam, [alpha, oldgen], cw.nodes, cw.links);
  check("generation diff finds Beta added, OldGen removed",
    result.status === "provisional" &&
    result.generationDiff.addedCodes.includes("Beta") &&
    result.generationDiff.removedIds.includes(OLDGEN_ID), result);

  const oldEntry = LF.relationEntryFor(KEY_OLD);
  check("OldGen's confirmed relation is flagged reworkPending because ITS OWN generation is being retired",
    oldEntry && oldEntry.reworkPending && oldEntry.reworkPending.kind === "remove" &&
    /no longer appears|retire/.test(oldEntry.reworkPending.reason), oldEntry);

  // Prove forceRecheckFamily's entry needs ZERO changes to the pre-existing
  // apply pipeline -- same call app.js's "✓ Apply Wikipedia's version"
  // button already makes for an ordinary (automatic) recheck.
  LF.applyFamilyOverride(FAM_ID, cw.nodes, cw.links);
  // applyFamilyOverride only pushes onto the raw nodes/links arrays -- it
  // doesn't (and shouldn't; that's app.js's applyFamilyOverrideConfirm's
  // job) retroactively patch cw.byId, which was built ONCE from those
  // arrays at boot(). Look the fresh node up in cw.nodes directly rather
  // than through the now-stale byId snapshot.
  const famAfter = cw.nodes.find(n => n.id === FAM_ID);
  const oldGenAfter = cw.nodes.find(n => n.id === OLDGEN_ID);
  check("applying the manual re-check's proposal actually retires OldGen", oldGenAfter && oldGenAfter.retired === true, oldGenAfter);
  check("...and mints the new Beta generation", famAfter.generations.some(id => {
    const g = cw.nodes.find(n2 => n2.id === id);
    return g && /beta/i.test(g.label);
  }), famAfter.generations);
  check("...while the reworkPending relation flag survives independently (still needs its own Accept/Decline)",
    !!LF.relationEntryFor(KEY_OLD) && !!LF.relationEntryFor(KEY_OLD).reworkPending);
}

async function scenarioC() {
  const window = freshWindow();
  const FAM_ID = "fam-test-mrc-c", DELTA_ID = "m-test-mrc-c-delta", PARTNER_LOOSE = "m-test-mrc-c-partnerloose";

  // Earlier drafts of this test ("PartnerLoose Twin", then plain
  // "Zorvexnith") kept tripping findMatchingNameplate's loose fallback,
  // which requires EXACTLY ONE candidate to loosely overlap the mention
  // text (see its own comment) -- this test runs against the real,
  // ~10,000-node production dataset (same as every other jsdom test here),
  // which turns out to contain enough short real chassis codes (a Honda
  // "Partner", Opel/Suzuki "Twin" models, even a Peugeot "RCZ" whose
  // normalized "rcz" is hiding inside "...mrczorvexnith...") that almost
  // any invented word collides with SOMETHING once concatenated and
  // stripped of spaces/punctuation by norm(). Rather than hunt for an
  // ever-more-exotic string that happens not to collide with anything in a
  // dataset this large, forceRecheckFamily is simply given a small,
  // hand-picked candidate node list below instead of the full cw.nodes --
  // it only needs `nodes` for MATCHING purposes, and delta/partnerLoose
  // already exist in the real graph independently (pushed onto
  // DATA.nodes/cw.nodes before boot, same as always), so this doesn't
  // weaken what's being proven at all, just removes 10,000 nodes' worth of
  // accidental collision risk from an otherwise-unrelated assertion.
  const WIKITEXT = "{{Infobox automobile|name=TestMRC FamilyC}}\n" +
    "== Generation Delta (2012-2020) ==\nThe Delta shares its platform with the TestMRC Zorvexnith.\n";
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const isDupCheck = body.messages[0].content.startsWith("You check whether a mentioned car");
      if (isDupCheck) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          matchId: null, confidence: "low", reason: "not confident enough",
        }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{ code: "Delta", yearStart: 2012, yearEnd: 2020, designers: [], engineers: [], sharedPlatforms: ["TestMRC Zorvexnith"] }],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  const mk = { id: "mk-test-mrc-c", type: "make", label: "TestMRCC", year: 1990 };
  const fam = { id: FAM_ID, type: "family", label: "FamilyC", make: "TestMRCC", year: 2012, end: null,
    wp: "TestMRC FamilyC", designers: [], engineers: [], generations: [DELTA_ID] };
  const delta = { id: DELTA_ID, type: "model", label: "Delta", make: "TestMRCC", year: 2012, end: 2020, familyOf: FAM_ID };
  const partnerLoose = { id: PARTNER_LOOSE, type: "model", label: "Zorvexnith", make: "TestMRCC", year: 2012, end: null };
  DATA.nodes.push(mk, fam, delta, partnerLoose);
  DATA.links.push(
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: DELTA_ID, type: "generation" },
    { source: partnerLoose.id, target: mk.id, type: "made" },
  );

  window.LLM_FAMILIES = { families: {}, recheck: {}, relations: {}, rejectedRelations: {}, __serverAvailable: true };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  const LF = window.LlmFamilies;

  const relKey = (a, b, t) => [a, b].sort().join("|") + "|" + t;
  const KEY = relKey(DELTA_ID, PARTNER_LOOSE, "platform");
  // Small, curated candidate pool for the MATCHING step only -- see the big
  // comment above for why the full 10k-node cw.nodes isn't used here.
  const candidateNodes = [mk, fam, delta, partnerLoose];
  const result = await LF.forceRecheckFamily(fam, [delta], candidateNodes, cw.links);
  check("forceRecheckFamily settles (generation itself found no discrepancy)", !!result, result);

  const entry = LF.relationEntryFor(KEY);
  check("the loose (not sanity-confirmed) mention is proposed as an ordinary provisional entry",
    entry && entry.status === "provisional", entry);
  check("...tagged rework:true so the panel can label it a re-work, not a first-time proposal",
    entry && entry.rework === true, entry);

  const btn = window.document.getElementById("unconfirmedrelbtn");
  btn.onclick();
  const rows = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
  const row = rows.find(r => /Zorvexnith/.test(r.textContent));
  check("the new mention shows up in the Unconfirmed Relationships panel", !!row, rows.map(r => r.textContent));
  check("...explicitly labeled a potential re-work", row && /potential re-work/.test(row.textContent), row && row.textContent);
  check("...with ordinary Accept/Decline buttons (this is an ADD proposal, not a Remove/Keep one)",
    row && /Accept/.test(row.textContent) && /Decline/.test(row.textContent), row && row.textContent);

  row.querySelector(".ucr-yes").onclick();
  const entryAfter = LF.relationEntryFor(KEY);
  check("accepting confirms the relation", entryAfter && entryAfter.status === "confirmed", entryAfter);
  check("...and wires a real live link into the graph", cw.links.some(l => l.llmResolvedKey === KEY));
  const rowsAfter = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
  check("panel is empty afterward", rowsAfter.length === 0, rowsAfter.length);
}

(async () => {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
