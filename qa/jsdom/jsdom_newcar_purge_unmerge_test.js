// Three real user requests, all about taking things back out of the graph:
//
//  1. "any car that was added newly (for example through me manually adding
//     it or from it being added due to the car being added from another
//     wikipedia page that discovered a particular car), it should also be
//     fully deletable in an easy way... there should be a single button to
//     delete all newly created makes and models, like a resetting of the
//     newly added cars memory... (and a dropdown where the user can select a
//     particular make and model)"
//  2. "there is a 'deleted so far' section, which I want to also have a
//     'clear' option which lets me remove the cars completely, so they are
//     still deleted but also do not appear in the 'deleted so far', since
//     they are completely deleted from the system, including in any file
//     which this information was ever stored"
//  3. "I also want an 'unmerge' option just like how there is a 'merge'
//     option in the 'modify existing car' section, if the car that I selected
//     is a nameplate. This would unmerge all of the generations of the car
//     from the existing 'nameplate' of the car."
//
// The properties that actually matter, and are asserted below:
//   * "newly added" means exactly "not from the build-time snapshot" -- never
//     a harvested car, never a generation, never a merge's own stand-in
//   * the sweep is ONE restorable record, not one per car
//   * a purge really does empty every other key in the store, not just hide
//     the node -- and the car cannot be re-minted or re-created afterwards,
//     which is the whole difference between "deleted" and "completely deleted"
//   * a purged deletion leaves the Deleted-so-far list
//   * unmerge frees adopted cars back to standalone models with everything
//     they own intact, retires the ones that only ever existed as generations,
//     and survives a reload (it's a record, replayed, like everything else)
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

const MK = "mk-np-test";
const HARD = "m-np-hard";                 // harvested plain model
const FAM = "fam-np-alpha";               // harvested nameplate
const G1 = "m-np-alpha-1", G2 = "m-np-alpha-2";
const USERCAR = "usercar-np-typed";       // added by hand
const LLMCAR = "llm-related-npco-minted"; // discovered by the LLM
const LLMMAKE = "llm-make-npnew";         // marque the LLM had to invent
const LLMCAR2 = "llm-related-npnew-other";

// The store the server would have handed back -- every key the purge has to
// sweep is seeded with something pointing at LLMCAR, so "wipes it from every
// file" is a real assertion rather than a hopeful one.
function seedStore() {
  return {
    families: { [LLMCAR]: { status: "single" } },
    recheck: { [LLMCAR]: { status: "no-wiki-link" } },
    genResearch: { [LLMCAR]: { status: "done" } },
    mintedFacts: { [LLMCAR]: { year: 1998, source: "wikipedia" } },
    wpLinks: { [LLMCAR]: "Minted car" },
    dismissed: { [LLMCAR]: true },
    userCars: { [USERCAR]: { makeLabel: "NpCo", modelLabel: "Typed", wpTitle: null } },
    relations: {
      [[HARD, LLMCAR].sort().join("|") + "|platform"]: {
        status: "confirmed", famA: HARD, famB: LLMCAR, genIdA: HARD, genIdB: LLMCAR, relType: "platform",
      },
      [[HARD, G1].sort().join("|") + "|related"]: {
        status: "confirmed", famA: HARD, famB: FAM, genIdA: HARD, genIdB: G1, relType: "related",
      },
    },
    transitive: { [[LLMCAR, G2].sort().join("|") + "|related"]: { a: LLMCAR, b: G2, status: "proposed" } },
    rejectedRelations: { [[LLMCAR, G2].sort().join("|") + "|platform"]: true },
    deletions: {}, renames: {}, merges: {}, purged: {}, unmerges: {},
    __serverAvailable: true,
  };
}

function freshWindow(llmSeed) {
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
  const DATA = window.CARDATA;
  DATA.nodes.push(
    { id: MK, type: "make", label: "NpCo", year: 1950 },
    { id: HARD, type: "model", label: "Harvested", make: "NpCo", year: 1990, end: 2000 },
    { id: FAM, type: "family", label: "Alpha", make: "NpCo", year: 1990, end: null, generations: [G1, G2] },
    { id: G1, type: "model", label: "Alpha I", make: "NpCo", familyOf: FAM, year: 1990, end: 2000 },
    { id: G2, type: "model", label: "Alpha II", make: "NpCo", familyOf: FAM, year: 2000, end: null },
    { id: LLMCAR, type: "model", label: "Minted", make: "NpCo", year: 1998, end: null, llmGenerated: true, llmCreatedNode: true },
    { id: LLMMAKE, type: "make", label: "NpNew", year: null, llmGenerated: true },
    { id: LLMCAR2, type: "model", label: "Other", make: "NpNew", year: null, end: null, llmGenerated: true, llmCreatedNode: true },
  );
  DATA.links.push(
    { source: HARD, target: MK, type: "made" }, { source: FAM, target: MK, type: "made" },
    { source: LLMCAR, target: MK, type: "made" }, { source: LLMCAR2, target: LLMMAKE, type: "made" },
    { source: FAM, target: G1, type: "generation" }, { source: FAM, target: G2, type: "generation" },
    { source: HARD, target: LLMCAR, type: "platform" },
  );
  window.LLM_FAMILIES = Object.assign(seedStore(), llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  window.CarWeb.boot();
  window.CarWeb.setYearRange(1900, window.CarWeb.yearRange().max);
  return window;
}

// ============ 1. newly added cars ============
console.log("--- what counts as 'newly added' ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  const ids = LF.newlyAddedNodes(cw.nodes).map(n => n.id);

  check("the LLM-minted car is newly added", ids.includes(LLMCAR));
  check("the marque the LLM had to invent is too", ids.includes(LLMMAKE));
  check("a hand-typed car is too", ids.includes(USERCAR), JSON.stringify(ids));
  check("a harvested car is NOT", !ids.includes(HARD));
  check("a harvested nameplate is NOT", !ids.includes(FAM));
  check("a generation is NOT listed on its own", !ids.includes(G1) && !ids.includes(G2));
  check("a harvested marque is NOT", !ids.includes(MK));
  check("isNewlyAdded agrees with the list",
    LF.isNewlyAdded(cw.byId.get(LLMCAR)) && !LF.isNewlyAdded(cw.byId.get(HARD)));
}

console.log("\n--- deleting them all in one go ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  const before = LF.newlyAddedNodes(cw.nodes).length;
  const res = LF.deleteNewCars(cw.nodes, cw.links, null, "reset");
  check("the sweep reports success", res.ok, JSON.stringify(res));
  check("it took every newly added car", res.removed === before, `${res.removed} of ${before}`);
  check("all of them are hidden", [LLMCAR, LLMMAKE, LLMCAR2, USERCAR].every(id => cw.byId.get(id).retired));
  check("harvested data is untouched", [HARD, FAM, G1, G2, MK].every(id => !cw.byId.get(id).retired));
  check("it's gone from search", !cw.searchAll("Minted").some(n => n.id === LLMCAR));

  const recs = LF.allDeletions();
  check("it's ONE record, not one per car", recs.length === 1, recs.length);
  check("...flagged as a batch", recs[0].batch === true);
  check("...and not as harvested data", recs[0].hard === false);
  check("...listing every id it hid", recs[0].cascadeIds.includes(LLMCAR) && recs[0].cascadeIds.includes(USERCAR));

  const back = LF.restoreNode(recs[0].id, cw.nodes, cw.links);
  check("one restore brings the whole sweep back", back.ok);
  check("...all of it", [LLMCAR, LLMMAKE, LLMCAR2, USERCAR].every(id => !cw.byId.get(id).retired));
  check("the record is gone", LF.allDeletions().length === 0);
}

console.log("\n--- deleting just one, picked from the dropdown ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  const res = LF.deleteNewCars(cw.nodes, cw.links, [LLMCAR], null);
  check("one-car sweep succeeded", res.ok);
  check("...and took only that one", res.removed === 1 && cw.byId.get(LLMCAR).retired && !cw.byId.get(USERCAR).retired);
  check("...labelled with the car's own name, not a count",
    /Minted/.test(LF.allDeletions()[0].label), LF.allDeletions()[0].label);
}

console.log("\n--- the dropdown itself ---");
{
  const window = freshWindow();
  const doc = window.document;
  doc.getElementById("deletebtn").onclick();
  const sel = doc.getElementById("newcars-pick");
  check("the panel has a newly-added dropdown", !!sel);
  const values = [...sel.options].map(o => o.value);
  check("it lists the newly added cars", values.includes(LLMCAR) && values.includes(USERCAR), JSON.stringify(values));
  check("...and nothing harvested", !values.includes(HARD) && !values.includes(FAM));
  check("its labels say how each one got here", [...sel.options].some(o => /found by the LLM/.test(o.textContent)));
  check("the delete-all button says how many", /\d+ newly added car/.test(doc.getElementById("newcars-delete-all").textContent),
    doc.getElementById("newcars-delete-all").textContent);
}

// ============ 2. clear for good ============
console.log("\n--- clearing a deleted car for good ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  LF.deleteNode(cw.byId.get(LLMCAR), cw.nodes, cw.links, null);
  check("it starts out on the restorable list", LF.allDeletions().some(d => d.id === LLMCAR));

  const res = LF.purgeDeletion(LLMCAR, cw.nodes, cw.links);
  check("the purge reports success", res.ok, JSON.stringify(res));
  check("it has left 'Deleted so far'", !LF.allDeletions().some(d => d.id === LLMCAR));
  check("...but is still gone from the graph", cw.byId.get(LLMCAR).retired);
  check("...and is recorded as purged", LF.isPurged(LLMCAR));
  check("restoring it is no longer possible", !LF.restoreNode(LLMCAR, cw.nodes, cw.links).ok);

  // "including in any file which this information was ever stored"
  const store = LF.__debugStore ? LF.__debugStore() : null;
  const seen = JSON.stringify(window.LLM_FAMILIES);   // untouched original, for contrast
  check("(fixture really did reference it everywhere)", seen.includes(LLMCAR));
  const purgedIds = LF.allPurged().map(p => p.id);
  check("the tombstone names it", purgedIds.includes(LLMCAR));
}

console.log("\n--- what a purge actually wipes ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  // Capture what the store looked like by round-tripping it through persist:
  // the module POSTs its whole store, so the fetch body is the file's content.
  let lastBody = null;
  window.fetch = (url, opts) => {
    if (opts && opts.body) lastBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  LF.deleteNode(cw.byId.get(LLMCAR), cw.nodes, cw.links, null);
  LF.purgeDeletion(LLMCAR, cw.nodes, cw.links);
  check("the store was written back", !!lastBody);
  if (lastBody) {
    check("its families entry is gone", !(LLMCAR in lastBody.families));
    check("its recheck entry is gone", !(LLMCAR in lastBody.recheck));
    check("its cached facts are gone", !(LLMCAR in lastBody.mintedFacts));
    check("its Wikipedia link is gone", !(LLMCAR in lastBody.wpLinks));
    check("its dismissals are gone", !(LLMCAR in lastBody.dismissed));
    check("its generation research is gone", !(LLMCAR in lastBody.genResearch));
    check("every relation naming it is gone",
      !Object.keys(lastBody.relations).some(k => k.includes(LLMCAR)) &&
      !Object.values(lastBody.relations).some(e => [e.famA, e.famB, e.genIdA, e.genIdB].includes(LLMCAR)));
    check("its transitive proposal is gone",
      !Object.keys(lastBody.transitive).some(k => k.includes(LLMCAR)));
    check("its rejected-relation keys are gone",
      !Object.keys(lastBody.rejectedRelations).some(k => k.includes(LLMCAR)));
    check("a relation about OTHER cars survived",
      Object.values(lastBody.relations).some(e => e.genIdA === HARD && e.genIdB === G1));
    check("the deletion record is gone", !(LLMCAR in lastBody.deletions));
    check("...replaced by a tombstone", LLMCAR in lastBody.purged);
  }
}

console.log("\n--- a purged car cannot come back ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  LF.deleteNode(cw.byId.get(LLMCAR), cw.nodes, cw.links, null);
  LF.purgeDeletion(LLMCAR, cw.nodes, cw.links);
  // mintRelatedNode is the path that re-creates an LLM-discovered car from
  // the article that named it -- the exact route a purged car would sneak
  // back in through on the very next check.
  const minted = LF.mintRelatedNode(cw.nodes, cw.links, "NpCo Minted", null, HARD);
  check("re-minting it from a mention returns nothing", minted === null || minted.retired === true,
    minted && minted.id);
}

console.log("\n--- a purged hand-added car stays gone across a reload ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  let lastBody = null;
  window.fetch = (url, opts) => {
    if (opts && opts.body) lastBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  LF.deleteNode(cw.byId.get(USERCAR), cw.nodes, cw.links, null);
  LF.purgeDeletion(USERCAR, cw.nodes, cw.links);
  check("the userCars entry is gone from the file", lastBody && !(USERCAR in lastBody.userCars));

  const w2 = freshWindow(lastBody);
  check("...so the next boot never re-creates it",
    !w2.CarWeb.byId.has(USERCAR) || w2.CarWeb.byId.get(USERCAR).retired);
}

console.log("\n--- purging a HARVESTED car (which data.js rebuilds every boot) ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  let lastBody = null;
  window.fetch = (url, opts) => {
    if (opts && opts.body) lastBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  LF.deleteNode(cw.byId.get(HARD), cw.nodes, cw.links, null);
  LF.purgeDeletion(HARD, cw.nodes, cw.links);
  const w2 = freshWindow(lastBody);
  check("it is still hidden on the next boot", w2.CarWeb.byId.get(HARD).retired);
  check("...and still not on the restorable list", !w2.LlmFamilies.allDeletions().some(d => d.id === HARD));
  check("...while the rest of its make is fine", !w2.CarWeb.byId.get(FAM).retired);
}

// ============ 3. unmerge ============
console.log("\n--- unmerging a hand-merged nameplate ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  // Build one the way the Modify Existing Car panel does, then take it apart.
  const merged = LF.mergeModelsIntoNameplate(HARD, [LLMCAR], cw.nodes, cw.links);
  check("(fixture) the merge worked", merged.ok, JSON.stringify(merged));
  const primary = cw.byId.get(HARD);
  check("(fixture) it's a nameplate now", primary.type === "family");

  const res = LF.unmergeNameplate(HARD, cw.nodes, cw.links);
  check("unmerge reports success", res.ok, JSON.stringify(res));
  check("the nameplate is a plain model again", primary.type === "model", primary.type);
  check("the adopted car is standalone again",
    !cw.byId.get(LLMCAR).familyOf && !cw.byId.get(LLMCAR).retired);
  check("...and kept its own year", cw.byId.get(LLMCAR).year === 1998);
  check("the merge's own stand-in generation is retired",
    cw.nodes.filter(n => n.mergeGenerated && !n.retired).length === 0);
  check("no generation links survive", !cw.links.some(l =>
    l.type === "generation" && !l.retired && [l.sn && l.sn.id, l.tn && l.tn.id].includes(HARD)));
  check("nothing was deleted", cw.nodes.some(n => n.id === LLMCAR));
  check("the merge record was dropped so it can't rebuild itself",
    !LF.allMerges().some(m => m.id === HARD));
  check("the unmerge is on record", LF.isUnmerged(HARD));
}

console.log("\n--- unmerging a harvested nameplate ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  const res = LF.unmergeNameplate(FAM, cw.nodes, cw.links);
  check("unmerge reports success", res.ok, JSON.stringify(res));
  check("...for both its generations", res.generations === 2, res.generations);
  check("each generation is a standalone model now",
    [G1, G2].every(id => !cw.byId.get(id).familyOf && cw.byId.get(id).type === "model" && !cw.byId.get(id).retired));
  check("...keeping their own years", cw.byId.get(G1).year === 1990 && cw.byId.get(G2).year === 2000);
  check("...and findable in search", cw.searchAll("Alpha I").some(n => n.id === G1));
  check("the empty nameplate is retired", cw.byId.get(FAM).retired);
  // A generation used to reach its marque only through its nameplate, so
  // freeing it without a "made" link of its own would leave a car floating.
  // l.sn/l.tn are only wired at boot (and by the panel's own splice), so this
  // reads the raw endpoints -- d3 may have turned either into a node object.
  const lid = v => (v && typeof v === "object" && v.id) ? v.id : v;
  check("each freed car is connected to its marque", [G1, G2].every(id =>
    cw.links.some(l => l.type === "made" && !l.retired &&
      [lid(l.source), lid(l.target)].includes(id) &&
      [lid(l.source), lid(l.target)].includes(MK))));
}

console.log("\n--- an unmerge survives a reload, and can be undone ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  let lastBody = null;
  window.fetch = (url, opts) => {
    if (opts && opts.body) lastBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  LF.unmergeNameplate(FAM, cw.nodes, cw.links);
  check("the decision was written to the file", lastBody && (FAM in lastBody.unmerges));

  const w2 = freshWindow(lastBody);
  check("the next boot replays it", [G1, G2].every(id => !w2.CarWeb.byId.get(id).familyOf));
  check("...and the nameplate stays taken apart", w2.CarWeb.byId.get(FAM).retired);

  const body2 = JSON.parse(JSON.stringify(lastBody));
  delete body2.unmerges[FAM];
  const w3 = freshWindow(body2);
  check("forgetting the record puts the nameplate back",
    !w3.CarWeb.byId.get(FAM).retired && w3.CarWeb.byId.get(G1).familyOf === FAM);
}

console.log("\n--- unmerge is offered only for a nameplate ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies, doc = window.document;
  const res = LF.unmergeNameplate(HARD, cw.nodes, cw.links);
  check("a plain model can't be unmerged", !res.ok, JSON.stringify(res));

  doc.getElementById("modifycarbtn").onclick();
  const sec = doc.getElementById("modifycar-unmerge-section");
  check("the panel has an unmerge section", !!sec);
  window.CarWeb.openDetail(cw.byId.get(FAM));
  doc.getElementById("modifycarbtn").onclick();     // close
  doc.getElementById("modifycarbtn").onclick();     // reopen, pre-selecting the nameplate
  check("...shown for a nameplate", !sec.hidden);
  window.CarWeb.openDetail(cw.byId.get(HARD));
  doc.getElementById("modifycarbtn").onclick();
  doc.getElementById("modifycarbtn").onclick();
  check("...and hidden for a plain model", sec.hidden);
}

console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
process.exit(fails ? 1 : 0);
