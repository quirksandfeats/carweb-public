// Real user request: a brand-new node minted from something the LLM found
// (a related car with no existing graph entry, or a designer/engineer name
// with no existing person node) used to get year/end (or born/died/country)
// hardcoded to null forever, with nothing ever attempting to find the real
// value -- the reported case was the Puch G, minted as a Mercedes-Benz
// G-Class platform-mate, stuck at year: null. scheduleFactBackfill (and its
// two callers, mintRelatedNode + the two resolvePerson/resolvePersonNode
// implementations) in llm_families.js is the fix: a background, two-tier
// "big attempt" -- (1) fetch the new node's own Wikipedia article and ask
// the LLM to extract the fact from real text, (2) only if that finds
// nothing, fall back to asking the LLM to recall the fact from its own
// training knowledge, trusting only a HIGH-confidence answer. Whatever's
// found (including a genuine "couldn't find one") is cached in
// store.mintedFacts so a later boot reuses the answer instead of repeating
// the lookup (or losing it) every time the page reloads and re-mints the
// same node from a confirmed relation.
//
// This test drives the whole thing through the real public API
// (applyConfirmed, exactly like a real confirmed nameplate-split proposal
// would), with a mocked fetch() standing in for both the Wikipedia API and
// serve.py's /api/llm/chat + /api/llm-families -- and proves:
//   1. a new model with a real Wikipedia production year gets it (grounded tier)
//   2. a new person with no Wikipedia article falls back to LLM recall (knowledge tier)
//   3. a mention neither tier can resolve stays null, but the "checked, found
//      nothing" result is still cached (so it isn't retried forever)
//   4. onFactsUpdate fires so app.js knows to redraw
//   5. a second, independent "boot" (fresh nodes/links, same store) reuses
//      the cached answers with ZERO extra network/LLM calls
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
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };

// ---------- mocked network: Wikipedia API + serve.py's /api/llm/chat and /api/llm-families ----------
const chatCalls = []; // {system, user}
const persistBodies = [];
const WIKITEXT_PUCHISH = `{{Infobox automobile
| name = TestBackfill Puchish
| production = 1979-present
| related = TestBackfillMB Gwagenish2
}}
'''TestBackfill Puchish''' is a badge-engineered Austrian variant, produced from 1979 to the present day.`;

window.fetch = (url, opts) => {
  const u = String(url);
  if (u.indexOf("en.wikipedia.org") !== -1) {
    if (u.indexOf(encodeURIComponent("TestBackfill Puchish")) !== -1) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT_PUCHISH } } }) });
    }
    // Every other title in this test (the unresolvable mentions, and the
    // two person names) has no article -- a real, common case (see
    // fetchArticleDigest's own error path).
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  if (u === "/api/llm/chat" && opts && opts.method === "POST") {
    const body = JSON.parse(opts.body);
    const sys = body.messages[0].content;
    const user = body.messages[1].content;
    chatCalls.push({ sys, user });
    let content;
    if (sys.indexOf("OVERALL production year range") !== -1) {
      // grounded year-facts extraction -- only ever called for Puchish in
      // this test (the only title with a real article), so this can just
      // always answer for it.
      content = JSON.stringify({ yearStart: 1979, yearEnd: null });
    } else if (sys.indexOf("production year range of a specific car") !== -1) {
      // knowledge-recall fallback for a car -- distinguish by which car
      // name is in the user message, same way a real model reads it.
      if (user.indexOf("Unknownish") !== -1) content = JSON.stringify({ yearStart: null, yearEnd: null, confidence: "low" });
      else content = JSON.stringify({ yearStart: null, yearEnd: null, confidence: "low" }); // shouldn't be reached for Puchish
    } else if (sys.indexOf("basic biographical facts") !== -1) {
      // knowledge-recall fallback for a person
      if (user.indexOf("Backfillova") !== -1) content = JSON.stringify({ born: 1950, died: null, country: "TestCountria", confidence: "high" });
      else content = JSON.stringify({ born: null, died: null, country: null, confidence: "low" }); // Unknownguy
    } else {
      content = "{}";
    }
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  }
  if (u === "/api/llm-families" && opts && opts.method === "POST") {
    persistBodies.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};

global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
// Two separate nameplates: applySharedPlatformForSingleGen only reads
// entries with status "none" + exactly 1 generation (the "never split, but
// still mentions a related car" case -- the actual shape a Puch G mention
// on the plain G-Class article would take), while the designer/engineer
// mint path only runs inside applyConfirmed's per-generation loop, which
// requires a "confirmed" entry with 2+ generations. Splitting the test
// scenario across both is what a real Puch-G-style single-gen mention PLUS
// a real multi-gen designer/engineer credit would actually look like.
const SINGLE_GEN_ID = "m-test-backfill-gwagen";
const MULTI_GEN_ID = "m-test-backfill-splitcar";
let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestBackfillMB");
if (!mk) { mk = { id: "mk-test-backfill-mb", type: "make", label: "TestBackfillMB", year: 1950 }; DATA.nodes.push(mk); }
const singleGenCar = { id: SINGLE_GEN_ID, type: "model", label: "Gwagenish2", make: "TestBackfillMB", year: 1979, end: null, designers: [], engineers: [] };
const multiGenCar = { id: MULTI_GEN_ID, type: "model", label: "Splitcarish", make: "TestBackfillMB", year: 1980, end: null, designers: [], engineers: [] };
DATA.nodes.push(singleGenCar, multiGenCar);
DATA.links.push({ source: mk.id, target: singleGenCar.id, type: "made" }, { source: mk.id, target: multiGenCar.id, type: "made" });

// Seed both proposals BEFORE loading llm_families.js, exactly like
// index.html's own boot script seeds window.LLM_FAMILIES synchronously
// before app.js/llm_families.js run.
window.LLM_FAMILIES = {
  families: {
    [SINGLE_GEN_ID]: {
      status: "none",
      proposal: {
        generations: [{
          code: "Gwagenish2", yearStart: 1979, yearEnd: null, designers: [], engineers: [],
          sharedPlatforms: ["TestBackfill Puchish", "TestBackfill Unknownish"],
        }],
      },
    },
    [MULTI_GEN_ID]: {
      status: "confirmed",
      proposal: {
        generations: [
          { code: "A1", yearStart: 1980, yearEnd: 1990, designers: ["Testperson Backfillova"], engineers: [], sharedPlatforms: [] },
          { code: "A2", yearStart: 1990, yearEnd: 2000, designers: [], engineers: ["Testperson Unknownguy"], sharedPlatforms: [] },
        ],
      },
    },
  },
  relations: {}, recheck: {}, rejectedRelations: {}, dismissed: {}, mintedFacts: {},
  __serverAvailable: true,
};
loadScript("llm_families.js");

const LF = window.LlmFamilies;
// Background LLM work (this backfill, a minted car's own article lookup, a
// related partner's generation check) is now gated on the user actually
// having asked for LLM work -- real bug report: "the LLM search toggle isn't
// turned on, I simply clicked on a car and it did the search anyways", with a
// terminal full of calls fired by a bare page load. This file drives
// llm_families.js directly rather than through app.js's toggle, so it has to
// authorise itself the way app.js's setLlmCheck(true) would.
// See setBackgroundAllowed.
LF.setBackgroundAllowed(true);
let factsUpdates = 0;
LF.onFactsUpdate(() => { factsUpdates++; });

function flush(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 40); i++) p = p.then(() => {});
  return p;
}

(async function run() {
  const nodes = DATA.nodes, links = DATA.links;
  LF.applySharedPlatformForSingleGen(nodes, links); // the Puch-G-shaped case: never split, still names a related car
  LF.applyConfirmed(nodes, links); // the designer/engineer-credit case: a real multi-generation split

  // ---------- immediately after applyConfirmed: nulls, backfill not finished yet ----------
  const puchish = nodes.find(n => n.id === "llm-related-testbackfill-puchish");
  const unknownish = nodes.find(n => n.id === "llm-related-testbackfill-unknownish");
  const backfillova = nodes.find(n => n.type === "person" && n.label === "Testperson Backfillova");
  const unknownguy = nodes.find(n => n.type === "person" && n.label === "Testperson Unknownguy");
  check("Puch-G-like mention minted a new model node", !!puchish);
  check("new model starts at year: null (backfill hasn't resolved yet)", puchish && puchish.year === null, puchish && puchish.year);
  check("unresolvable mention also minted a new model node", !!unknownish);
  check("Backfillova minted as a new person node", !!backfillova);
  check("new person starts at born: null", backfillova && backfillova.born === null);
  check("Unknownguy minted as a new person node", !!unknownguy);

  await flush();

  // ---------- after the background backfill resolves ----------
  check("Puchish got its real production year from the grounded Wikipedia lookup",
    puchish.year === 1979 && puchish.end === null, puchish.year + "/" + puchish.end);
  check("Puchish is tagged with its fact source", puchish.factsSource === "wikipedia", puchish.factsSource);
  check("Backfillova got born year from the LLM-recall fallback (no Wikipedia article)",
    backfillova.born === 1950 && backfillova.country === "TestCountria", backfillova.born + " " + backfillova.country);
  check("Backfillova is tagged with its fact source", backfillova.factsSource === "llm-recall", backfillova.factsSource);
  check("Unknownish stayed null -- neither tier could resolve it (honest null, not a guess)",
    unknownish.year === null && unknownish.end === null);
  check("Unknownguy stayed null -- neither tier could resolve it",
    unknownguy.born === null && unknownguy.died === null && unknownguy.country === null);

  const lastPersist = persistBodies[persistBodies.length - 1];
  check("mintedFacts was persisted to serve.py for the resolved model",
    lastPersist && lastPersist.mintedFacts && lastPersist.mintedFacts["llm-related-testbackfill-puchish"] &&
    lastPersist.mintedFacts["llm-related-testbackfill-puchish"].year === 1979,
    lastPersist && lastPersist.mintedFacts);
  check("mintedFacts was persisted for the unresolved model too (negative-result caching)",
    lastPersist && lastPersist.mintedFacts && ("llm-related-testbackfill-unknownish" in lastPersist.mintedFacts),
    lastPersist && lastPersist.mintedFacts && lastPersist.mintedFacts["llm-related-testbackfill-unknownish"]);
  check("mintedFacts was persisted for both person lookups",
    lastPersist && lastPersist.mintedFacts &&
    lastPersist.mintedFacts[backfillova.id] && lastPersist.mintedFacts[backfillova.id].born === 1950 &&
    (unknownguy.id in lastPersist.mintedFacts));

  check("onFactsUpdate fired at least once per resolved node (4 nodes backfilled)", factsUpdates >= 4, factsUpdates);

  // ---------- second, independent "boot": fresh nodes/links, same module-level store ----------
  const callsBeforeSecondBoot = chatCalls.length;
  const nodes2 = [
    { id: mk.id, type: "make", label: "TestBackfillMB", year: 1950 },
    { id: SINGLE_GEN_ID, type: "model", label: "Gwagenish2", make: "TestBackfillMB", year: 1979, end: null, designers: [], engineers: [] },
    { id: MULTI_GEN_ID, type: "model", label: "Splitcarish", make: "TestBackfillMB", year: 1980, end: null, designers: [], engineers: [] },
  ];
  const links2 = [{ source: mk.id, target: SINGLE_GEN_ID, type: "made" }, { source: mk.id, target: MULTI_GEN_ID, type: "made" }];
  LF.applySharedPlatformForSingleGen(nodes2, links2);
  LF.applyConfirmed(nodes2, links2);
  await flush(5);
  const puchish2 = nodes2.find(n => n.id === "llm-related-testbackfill-puchish");
  const backfillova2 = nodes2.find(n => n.type === "person" && n.label === "Testperson Backfillova");
  check("a fresh boot re-mints the same node with the CACHED year immediately (no waiting for a new fetch)",
    puchish2 && puchish2.year === 1979, puchish2 && puchish2.year);
  check("a fresh boot re-mints the same person with the CACHED born year immediately",
    backfillova2 && backfillova2.born === 1950, backfillova2 && backfillova2.born);
  check("reusing cached facts made ZERO new /api/llm/chat calls", chatCalls.length === callsBeforeSecondBoot,
    "before=" + callsBeforeSecondBoot + " after=" + chatCalls.length);

  console.log("\n" + (fails === 0 ? "ALL GREEN (0 failures)" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
