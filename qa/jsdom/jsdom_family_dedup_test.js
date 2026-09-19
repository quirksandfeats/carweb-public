// Verifies the LLM generation-list de-duplication fix (real bug report: the
// Mercedes-Benz SL-Class's R107 (1971-1989) already existed in the graph as
// its own fully independent, never-grouped standalone model -- its label
// never matched build_family_layer.py's "SL"/"SL-Class" base-name grouping
// pattern at all, so it was never a candidate for the family in the first
// place. When the LLM later re-read the SL-Class umbrella article and
// correctly identified R107 as one of its generations, minting a brand-new
// synthetic node for it produced a visible DUPLICATE. Per the reported
// requirement, the LLM's own read wins and the stale standalone becomes
// invisible -- never deleted -- unless the LLM output itself is later
// deleted, at which point it reverts with nothing to unwind.
//
// Second wave of coverage (follow-up bug-hunt): retiring the node alone
// isn't enough -- EVERYTHING the standalone knew has to survive onto the
// replacement generation:
//   - its platform/related/succession links to other cars (rebound copies)
//   - its direct designed/engineered links to person nodes
//   - its My Database data (db/dbspecs/dbphoto -> gold ring), garage flag
//   - its own dedicated Wikipedia article and real production years
//   - a persisted store.relations entry referencing its id must follow the
//     supersededBy redirect instead of wiring a link to a hidden node
//   - the footer counts must exclude the retired node and its dead links
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
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

const lid = v => (typeof v === "string" ? v : v && v.id);

const FAM_ID = "fam-test-sl";
const R230_ID = "m-test-sl-r230";
const STANDALONE_R107_ID = "m-test-r107-standalone"; // deliberately NOT familyOf FAM_ID, mirrors the real bug
const OTHER_ID = "m-test-928";
const PERSON_ID = "p-test-old-designer";
const NEW_GEN_ID = "llm-" + FAM_ID + "-r107"; // what applyFamilyOverride mints for code "R107"
const REL_KEY = [OTHER_ID, STANDALONE_R107_ID].sort().join("|") + "|platform";

// Seeds a family with one generation (R230) plus a fully independent
// standalone "R107" elsewhere in the graph, carrying everything a real
// long-lived node accumulates: a related link to another car, a designed
// link to a person, My Database data, a garage flag, its own article.
function seedFamily(DATA) {
  let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMercedes");
  if (!makeNode) { makeNode = { id: "mk-testmb", type: "make", label: "TestMercedes", year: 1926 }; DATA.nodes.push(makeNode); }
  const famNode = { id: FAM_ID, type: "family", label: "SL-Class", make: "TestMercedes", year: 1989, end: null,
    designers: [], engineers: [], generations: [R230_ID] };
  const r230 = { id: R230_ID, type: "model", label: "SL-Class R230", make: "TestMercedes", year: 2001, end: 2011,
    familyOf: FAM_ID, wp: "TestMercedes SL-Class (R230)", designers: [], engineers: [] };
  const standaloneR107 = { id: STANDALONE_R107_ID, type: "model", label: "R107", make: "TestMercedes", year: 1971, end: 1989,
    wp: "TestMercedes R107", designers: ["Old Standalone Designer"], engineers: [],
    db: true, dbspecs: { modelYear: "1985" }, dbphoto: "db_photos/test-r107.jpg", garage: true };
  const other = { id: OTHER_ID, type: "model", label: "Test928", make: "TestMercedes", year: 1978, end: 1995,
    wp: "TestMercedes Test928", designers: [], engineers: [] };
  const person = { id: PERSON_ID, type: "person", kind: "person", label: "Old Standalone Designer",
    roles: ["designer"], born: null, died: null, country: null, wp: null };
  DATA.nodes.push(famNode, r230, standaloneR107, other, person);
  DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" });
  DATA.links.push({ source: FAM_ID, target: R230_ID, type: "generation" });
  DATA.links.push({ source: STANDALONE_R107_ID, target: makeNode.id, type: "made" });
  DATA.links.push({ source: OTHER_ID, target: makeNode.id, type: "made" });
  DATA.links.push({ source: STANDALONE_R107_ID, target: OTHER_ID, type: "related", note: "test-related-note" });
  DATA.links.push({ source: STANDALONE_R107_ID, target: PERSON_ID, type: "designed" });
}

function freshWindow(llmFamiliesSeed) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("d3.min.js");
  loadScript("data.js");
  seedFamily(window.CARDATA);
  window.LLM_FAMILIES = llmFamiliesSeed;
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  return window;
}

// The LLM's fresh re-read of the umbrella article. R107's years are
// deliberately null here: the standalone's own real, harvested 1971-1989
// must be inherited by the replacement generation (a shallow umbrella read
// often has no per-generation years even when the standalone article did).
const freshProposal = {
  hasMultipleGenerations: true,
  generations: [
    { code: "R107", yearStart: null, yearEnd: null, designers: [], engineers: [] },
    { code: "R230", yearStart: 2001, yearEnd: 2011, designers: [], engineers: [] },
  ],
};

function countsExpectations(cw) {
  const models = cw.nodes.filter(n => n.type === "model" && !n.retired).length;
  const conns = cw.links.filter(l => {
    if (l.retired || l.type === "generation") return false;
    const s = l.sn || cw.byId.get(lid(l.source)), t = l.tn || cw.byId.get(lid(l.target));
    return s && t && !s.retired && !t.retired;
  }).length;
  return { models, conns };
}

// ---------- scenario 1: accept the override -> standalone retired, everything transplanted ----------
{
  const seed = {
    families: {}, relations: {},
    recheck: {
      [FAM_ID]: {
        status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "TestMercedes SL-Class",
        proposal: freshProposal,
        discrepancy: "Wikipedia currently describes 2 generations, but this nameplate currently shows 1 here",
        attempts: 1, feedback: [],
      },
    },
    __serverAvailable: true,
  };
  const window = freshWindow(seed);
  const cw = window.CarWeb;
  cw.boot();
  cw.setLlmCheck(true);
  const fam = cw.byId.get(FAM_ID);
  const standaloneBefore = cw.byId.get(STANDALONE_R107_ID);
  check("precondition: standalone R107 starts visible (not retired)", !standaloneBefore.retired);
  check("precondition: family starts with only R230", fam.generations.length === 1 && fam.generations.includes(R230_ID));

  cw.openDetail(fam);
  const yesBtn = window.document.querySelector(".dt-llmcheck .llm-yes");
  check("Accept button rendered for the discrepancy", !!yesBtn);
  yesBtn.onclick();

  check("family's generation list now has 2 generations (R107 + R230, not 3)", fam.generations.length === 2, fam.generations);

  const standaloneAfter = cw.byId.get(STANDALONE_R107_ID);
  check("the old standalone R107 node still exists (never deleted)", !!standaloneAfter);
  check("the old standalone R107 node is now retired (hidden)", standaloneAfter.retired === true);
  check("retired node is hidden from nodeInLayer everywhere", !cw.nodeInLayer(standaloneAfter));

  const testR107Ids = [STANDALONE_R107_ID, ...fam.generations];
  const visibleR107s = cw.nodes.filter(n => testR107Ids.includes(n.id) && !n.retired && n.label.toUpperCase().includes("R107"));
  check("exactly one visible R107 node after accepting (no duplicate)", visibleR107s.length === 1, visibleR107s.map(n => n.id));

  const newGen = cw.byId.get(NEW_GEN_ID);
  check("the new R107 generation node is a freshly-minted family generation", !!newGen && newGen.familyOf === FAM_ID, newGen && newGen.id);
  check("supersededBy pointer recorded on the retired standalone", standaloneAfter.supersededBy === NEW_GEN_ID, standaloneAfter.supersededBy);

  // ---- field transplant ----
  check("generation inherited the standalone's real production years (proposal had none)",
    newGen.year === 1971 && newGen.end === 1989, newGen.year + "-" + newGen.end);
  check("generation inherited the standalone's own dedicated Wikipedia article",
    newGen.wp === "TestMercedes R107", newGen.wp);
  check("generation inherited the My Database match (db + specs + photo)",
    newGen.db === true && newGen.dbspecs && newGen.dbspecs.modelYear === "1985" && newGen.dbphoto === "db_photos/test-r107.jpg");
  check("family inherited the db flag (gold ring shows on the collapsed nameplate too)",
    fam.db === true && (fam.dbGenerations || []).includes(NEW_GEN_ID), JSON.stringify(fam.dbGenerations));
  check("generation and family inherited the garage flag", newGen.garage === true && fam.garage === true);
  check("standalone's designer name merged into the generation's own text credits",
    (newGen.designers || []).includes("Old Standalone Designer"), newGen.designers);

  // ---- link transplant ----
  const reboundRel = cw.links.find(l => l.type === "related" && l.rebound &&
    ((lid(l.source) === NEW_GEN_ID && lid(l.target) === OTHER_ID) || (lid(l.source) === OTHER_ID && lid(l.target) === NEW_GEN_ID)));
  check("the standalone's 'related' connection to another car was rebound onto the generation", !!reboundRel);
  check("...carrying the original link's note along", reboundRel && reboundRel.note === "test-related-note", reboundRel && reboundRel.note);
  check("...and the rebound link is drawable (both endpoints wired and visible)",
    reboundRel && reboundRel.sn && reboundRel.tn && !reboundRel.sn.retired && !reboundRel.tn.retired);
  const reboundDesigned = cw.links.find(l => l.type === "designed" && l.rebound &&
    lid(l.source) === NEW_GEN_ID && lid(l.target) === PERSON_ID);
  check("the standalone's designed-by link to a real person node was rebound onto the generation", !!reboundDesigned);
  check("no duplicate person node was minted for the already-existing designer",
    cw.nodes.filter(n => n.type === "person" && n.label === "Old Standalone Designer").length === 1);
  const famDesigned = cw.links.some(l => l.type === "designed" && lid(l.source) === FAM_ID && lid(l.target) === PERSON_ID);
  check("the designer credit was also folded up to the family level", famDesigned);
  check("family text credits include the standalone's designer", fam.designers.includes("Old Standalone Designer"), fam.designers);

  check("every link in the whole graph still resolves to real sn/tn node objects after the override",
    cw.links.every(l => l.retired || (l.sn && l.tn)), cw.links.filter(l => !l.retired && (!l.sn || !l.tn)).length + " broken");

  // ---- footer counts ----
  const exp = countsExpectations(cw);
  const countsText = window.document.getElementById("counts").textContent;
  check("footer counts refreshed live after the override (not stale baked numbers)",
    countsText.startsWith(exp.models + " models"), countsText.slice(0, 40) + " | expected " + exp.models);
  // The standalone this scenario retired is not the only retired model in the
  // real graph any more -- foldCodeDuplicateModels retires the ones that turn
  // out to be a second copy of an existing generation -- so this asserts what
  // it is actually about: the count leaves out whatever is retired, and this
  // particular standalone is one of them.
  check("footer model count excludes the retired standalone",
    exp.models === cw.nodes.filter(n => n.type === "model" && !n.retired).length &&
    exp.models < cw.nodes.filter(n => n.type === "model").length &&
    cw.byId.get(STANDALONE_R107_ID).retired);
  check("footer connection count excludes links whose endpoint is retired",
    countsText.includes(exp.conns + " connections"), countsText);
}

// ---------- scenario 2: applied entry + persisted relation on a fresh boot ----------
{
  const seed = {
    families: {},
    // A relation the LLM had resolved against the STANDALONE before the
    // split existed -- on this boot the standalone is retired, so the link
    // must follow supersededBy onto the replacement generation instead of
    // being wired to a permanently-hidden node.
    relations: {
      [REL_KEY]: {
        status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
        famA: OTHER_ID, famB: STANDALONE_R107_ID, relType: "platform",
        codeA: "Test928", codeB: "R107", genIdA: OTHER_ID, genIdB: STANDALONE_R107_ID,
        reason: "test", llmDiscovered: true,
      },
    },
    recheck: {
      [FAM_ID]: {
        status: "applied", checkedAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
        sourceTitle: "TestMercedes SL-Class", proposal: freshProposal,
        discrepancy: "Wikipedia currently describes 2 generations, but this nameplate currently shows 1 here",
        attempts: 1, feedback: [],
      },
    },
    __serverAvailable: true,
  };
  const window = freshWindow(seed);
  const cw = window.CarWeb;
  cw.boot();
  const standalone = cw.byId.get(STANDALONE_R107_ID);
  check("re-applying an already-'applied' override on a fresh boot retires the standalone again", standalone.retired === true);

  const reboundRel = cw.links.find(l => l.type === "related" && l.rebound &&
    ((lid(l.source) === NEW_GEN_ID && lid(l.target) === OTHER_ID) || (lid(l.source) === OTHER_ID && lid(l.target) === NEW_GEN_ID)));
  check("boot-time re-apply re-mints the rebound 'related' link too", !!reboundRel);
  check("boot-time rebound link got wired into sn/tn like every other link", reboundRel && !!reboundRel.sn && !!reboundRel.tn);

  const resolvedLink = cw.links.find(l => l.llmResolvedKey === REL_KEY);
  check("persisted relation entry followed supersededBy to the replacement generation", !!resolvedLink &&
    ((lid(resolvedLink.source) === NEW_GEN_ID && lid(resolvedLink.target) === OTHER_ID) ||
     (lid(resolvedLink.source) === OTHER_ID && lid(resolvedLink.target) === NEW_GEN_ID)),
    resolvedLink && (lid(resolvedLink.source) + " <-> " + lid(resolvedLink.target)));

  // A retired standalone must be invisible to the LLM layer's own
  // eligibility too -- the cascade-discovery flow would otherwise burn an
  // llama.cpp call proposing a split on a node nobody can see or act on.
  check("a retired standalone is not eligible for a fresh LLM generation check",
    !window.LlmFamilies.isEligible(standalone));

  // ---- delete the override -> everything reverts on the next boot ----
  const seed2 = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  const window2 = freshWindow(seed2);
  const cw2 = window2.CarWeb;
  cw2.boot();
  const standalone2 = cw2.byId.get(STANDALONE_R107_ID);
  check("after the override is deleted, a fresh boot leaves the standalone un-retired", !standalone2.retired);
  check("and visible again via nodeInLayer, with zero extra unwinding needed", cw2.nodeInLayer(standalone2));
  // Rebound links from OTHER passes are fine and expected on real data (see
  // foldCodeDuplicateModels); what must be gone is anything rebound onto the
  // generation this override minted.
  check("no stale rebound links survive the revert",
    !cw2.links.some(l => l.rebound &&
      (lid(l.source) === STANDALONE_R107_ID || lid(l.target) === STANDALONE_R107_ID ||
       String(lid(l.source)).indexOf("llm-m-testmercedes-sl-class") === 0 ||
       String(lid(l.target)).indexOf("llm-m-testmercedes-sl-class") === 0)),
    cw2.links.filter(l => l.rebound).length + " rebound overall");
  const fam2 = cw2.byId.get(FAM_ID);
  check("the family reverts to just its original single generation", fam2.generations.length === 1 && fam2.generations.includes(R230_ID), fam2.generations);
  check("the standalone's original 'related' connection is live again",
    cw2.links.some(l => l.type === "related" && lid(l.source) === STANDALONE_R107_ID && lid(l.target) === OTHER_ID));
  const exp2 = countsExpectations(cw2);
  const countsText2 = window2.document.getElementById("counts").textContent;
  check("footer counts include the standalone again after the revert",
    countsText2.startsWith(exp2.models + " models") && countsText2.includes(exp2.conns + " connections"), countsText2.slice(0, 40));
}

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
