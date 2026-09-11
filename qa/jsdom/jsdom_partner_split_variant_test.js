// Two more from the same batch.
//
// 1. "It seems that the LLM doesn't properly find the generations for other
//    nameplates. For example, I selected the Honda Odyssey Nameplate, and saw
//    that it made a connection [to] the Acura MDX. In this case, the LLM
//    should have also looked at the Acura MDX and also checked its wikipedia
//    page and search for generations, and split up the Acura MDX into
//    generations, to then make the links between the generations of the Acura
//    MDX nameplate and the Honda Odyssey nameplate."
//
//    The cascade for this already existed -- and had been silently disabled
//    for exactly these cars by a feature added alongside it.
//    schedulePartnerCheck runs a background check on a matched partner and
//    stores the result; checkNodeCascade deliberately KEEPS a "provisional"
//    verdict in memory waiting to be applied. But needsCascadeCheck asked
//    only "does an entry exist?", so the moment that background check stored
//    its provisional split, the cascade branch was skipped and the relation
//    was disambiguated against the still-unsplit partner. The generations
//    were found, then thrown away.
//
// 2. "before creating a new make or model, check if there are any variants of
//    the name already existing but maybe written slightly differently (do
//    this with the LLM)." The model half of that has existed for a while
//    (askDuplicateCheck); minting a new MAKE had no such check at all, so a
//    marque spelled even slightly differently from the graph's own label
//    ("VW" vs "Volkswagen") minted a permanent duplicate marque -- and every
//    car minted under it inherited the wrong manufacturer.
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
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
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
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {}, __serverAvailable: true }, opts.llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  load("platforms.js");
  return window;
}

(async () => {
  // ============ 1. the Honda Odyssey / Acura MDX partner split ============
  console.log("--- a related partner is split into generations, then matched generation-to-generation ---");
  {
    const FAM = "fam-test-ps-odyssey", O1 = "m-test-ps-o1", O2 = "m-test-ps-o2";
    const PARTNER = "m-test-ps-mdx";
    const PARTNER_WP = "TestAcura MDX";
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-ps-h", type: "make", label: "TestHonda", year: 1948 };
        const mk2 = { id: "mk-test-ps-a", type: "make", label: "TestAcura", year: 1986 };
        DATA.nodes.push(mk, mk2,
          { id: FAM, type: "family", label: "Odysseyish", make: "TestHonda", wp: "TestHonda Odysseyish",
            year: 1994, end: null, generations: [O1, O2] },
          { id: O1, type: "model", label: "Odysseyish RA", make: "TestHonda", familyOf: FAM, year: 1994, end: 2004 },
          { id: O2, type: "model", label: "Odysseyish RL", make: "TestHonda", familyOf: FAM, year: 2004, end: null },
          // The partner: a plain, never-split model whose own article DOES
          // describe two generations.
          { id: PARTNER, type: "model", label: "MDXish", make: "TestAcura", wp: PARTNER_WP, year: 2000, end: null });
        DATA.links.push(
          { source: FAM, target: mk.id, type: "made" }, { source: PARTNER, target: mk2.id, type: "made" },
          { source: FAM, target: O1, type: "generation" }, { source: FAM, target: O2, type: "generation" },
          { source: FAM, target: PARTNER, type: "related",
            note: "The Odysseyish shares its platform with the TestAcura MDXish." });
      },
      fetchImpl: (url, opts) => {
        const u = String(url);
        if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
          const m = decodeURIComponent(u).match(/page=([^&]+)/);
          const title = m ? m[1].replace(/\+/g, " ").replace(/_/g, " ") : "";
          const wt = title === PARTNER_WP
            ? "The MDXish was built as the YD1 and later the YD2. == YD1 == The YD1 ran 2000-2006. == YD2 == The YD2 followed in 2006."
            : "The Odysseyish is a minivan related to the TestAcura MDXish.";
          return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
        }
        if (u === "/api/llm/chat") {
          const body = JSON.parse(opts.body);
          const sys = String(body.messages[0].content);
          if (sys.includes("You extract car production-generation data")) {
            // The partner's own article really does hide two generations.
            const user = String(body.messages[1].content);
            if (user.includes("MDXish")) {
              return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
                hasMultipleGenerations: true,
                generations: [
                  { code: "YD1", yearStart: 2000, yearEnd: 2006, designers: [], engineers: [], sharedPlatforms: [] },
                  { code: "YD2", yearStart: 2006, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] },
                ],
              }) } }] }) });
            }
            return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hasMultipleGenerations: false, generations: [] }) } }] }) });
          }
          // The relation call: now that BOTH sides are nameplates, it can
          // name a real generation on each.
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
            resolved: true, codeA: "Odysseyish RL", codeB: "MDXish YD2",
            reason: "The article explicitly states this platform pairing.",
          }) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    cw.setLlmCheck(true);

    const partner = cw.byId.get(PARTNER);
    check("fixture: the partner starts as a plain, ungrouped model", partner.type === "model" && !partner.familyOf);

    cw.openDetail(cw.byId.get(FAM));
    await sleep(250);

    check("the partner was checked and split into a real nameplate", partner.type === "family", partner.type);
    check("...with both of its own generations minted",
      (partner.generations || []).length === 2, JSON.stringify(partner.generations));
    // The whole point: the relation is now proposed between two specific
    // GENERATIONS, one from each nameplate -- not between a generation and a
    // whole un-split nameplate, which is all that was possible before.
    const key = [FAM, PARTNER].sort().join("|") + "|related";
    const entry = window.LlmFamilies.relationEntryFor(key);
    check("a relation verdict exists", !!entry, entry && entry.status);
    check("it resolved to the full generation<->generation tier",
      entry && entry.matchLevel === "generation", entry && entry.matchLevel);
    check("...naming a generation on OUR side", entry && entry.genIdA && entry.genIdA.startsWith("m-test-ps-o"), entry && entry.genIdA);
    check("...and one of the PARTNER's newly-minted generations",
      entry && entry.genIdB && (partner.generations || []).includes(entry.genIdB), entry && entry.genIdB);
    // An LLM-only resolution (no quote, no article code) correctly stays
    // provisional -- confirming it is what wires the real link in.
    check("it's held for review rather than auto-applied (no verifiable quote behind it)",
      entry && entry.status === "provisional", entry && entry.status);
    const yes = window.document.querySelector(".dt-relations .llm-rel-yes");
    check("a Yes/No box is showing for it", !!yes);
    if (yes) {
      yes.onclick();
      const resolved = cw.links.find(l => l.type === "related" && l.llmResolved && l.sn && l.tn &&
        [l.sn, l.tn].some(e => e.familyOf === FAM) && [l.sn, l.tn].some(e => e.familyOf === PARTNER));
      check("accepting wires a real generation<->generation link",
        !!resolved, resolved && `${resolved.sn.label} <-> ${resolved.tn.label}`);
    }
  }

  // ============ 2. a make spelled differently isn't minted twice ============
  console.log("\n--- a marque already in the graph under another spelling is reused, not duplicated ---");
  {
    const window = freshWindow({
      seed(DATA) {
        // The real marque, spelled out in full.
        DATA.nodes.push({ id: "mk-test-var-vw", type: "make", label: "Volkswagenish", year: 1937 },
          { id: "m-test-var-golf", type: "model", label: "Golfish", make: "Volkswagenish", year: 1974, end: null });
        DATA.links.push({ source: "m-test-var-golf", target: "mk-test-var-vw", type: "made" });
      },
      fetchImpl: (url, opts) => {
        if (String(url) === "/api/llm/chat") {
          const body = JSON.parse(opts.body);
          const sys = String(body.messages[0].content);
          if (sys.includes("car manufacturer named in a Wikipedia sentence")) {
            return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
              matchId: "mk-test-var-vw", confidence: "high",
              reason: "\"VWish\" is the common abbreviation of Volkswagenish.",
            }) } }] }) });
          }
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ matchId: null, confidence: "low", reason: "no" }) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      },
    });
    // Driven exactly the way the real flow does it: a "none" verdict whose
    // single generation carries a shared-platform mention gets resolved at
    // boot by applySharedPlatformForSingleGen -> resolveOnePlatformMention ->
    // mintRelatedNode, which is the call that consumes the variant verdict.
    const w2 = freshWindow({
      seed(DATA) {
        DATA.nodes.push({ id: "mk-test-var-vw", type: "make", label: "Volkswagenish", year: 1937 },
          { id: "m-test-var-golf", type: "model", label: "Golfish", make: "Volkswagenish", wp: "Golfish", year: 1974, end: null });
        DATA.links.push({ source: "m-test-var-golf", target: "mk-test-var-vw", type: "made" });
      },
      llmSeed: {
        families: {
          "m-test-var-golf": {
            status: "none", sourceTitle: "Golfish",
            proposal: { hasMultipleGenerations: false, generations: [{
              code: "Golfish", yearStart: 1974, yearEnd: null, designers: [], engineers: [],
              sharedPlatforms: ["VWish Passatish"],
              makeVariantMatches: { "VWish Passatish": { matchId: "mk-test-var-vw", makeGuessWords: 1, reason: "abbreviation" } },
            }] },
          },
        },
      },
    });
    const cw2 = w2.CarWeb;
    cw2.boot();
    const makes = cw2.nodes.filter(n => n.type === "make" && !n.retired);
    check("no duplicate marque was minted for the abbreviated spelling",
      !makes.some(m => /^VWish$/i.test(m.label)),
      JSON.stringify(makes.filter(m => /VW|Volks/i.test(m.label)).map(m => m.label)));
    const passat = cw2.nodes.find(n => n.type === "model" && /Passatish/.test(n.label));
    check("the related car WAS still minted", !!passat, passat && passat.label);
    check("...filed under the existing marque", passat && passat.make === "Volkswagenish", passat && passat.make);
    check("...with the marque stripped from its own model label", passat && passat.label === "Passatish", passat && passat.label);

    // And without the verdict, the old behaviour stands -- which is what
    // makes the check load-bearing rather than decorative.
    const w3 = freshWindow({
      seed(DATA) {
        DATA.nodes.push({ id: "mk-test-var-vw", type: "make", label: "Volkswagenish", year: 1937 },
          { id: "m-test-var-golf", type: "model", label: "Golfish", make: "Volkswagenish", wp: "Golfish", year: 1974, end: null });
        DATA.links.push({ source: "m-test-var-golf", target: "mk-test-var-vw", type: "made" });
      },
      llmSeed: {
        families: {
          "m-test-var-golf": {
            status: "none", sourceTitle: "Golfish",
            proposal: { hasMultipleGenerations: false, generations: [{
              code: "Golfish", yearStart: 1974, yearEnd: null, designers: [], engineers: [],
              sharedPlatforms: ["VWish Passatish"],
            }] },
          },
        },
      },
    });
    w3.CarWeb.boot();
    check("(control) with no variant verdict, a separate marque really would be minted",
      w3.CarWeb.nodes.some(n => n.type === "make" && /^VWish$/i.test(n.label)),
      JSON.stringify(w3.CarWeb.nodes.filter(n => n.type === "make" && /VW|Volks/i.test(n.label)).map(m => m.label)));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
