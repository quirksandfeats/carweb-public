// Universal delete (with recovery) and universal rename.
//
// Delete -- real user request: "I want to also be able to delete makes (and
// models, nameplates, or generations, or designers/engineers) within the
// 'tools' tab underneath the 'modify existing cars' button. This should be
// universally deletable, meaning that even if the data comes directly from
// dbpedia or my database, it should also be deletable, however should be
// stored somewhere that 'hard data' (not LLM data) has been deleted, and
// therefore should also be recoverable."
//
// Rename -- real user request: "within 'Modify existing cars', I should also
// be able to change the name of the make, model, nameplate,
// engineer/designer, etc..."
//
// The properties that actually matter, and are asserted below:
//   * every node type can be deleted, harvested or not
//   * a delete is a recorded HIDE, never an erase -- so it's exactly undoable
//   * deleting a parent takes its children, and restoring puts back exactly
//     that set (and nothing that was hidden for some other reason)
//   * harvested ("hard") data is flagged as such, since that's the half the
//     request asked to be recorded separately
//   * a deleted thing vanishes from the graph, the cards, search and the
//     counts -- and comes all the way back
//   * renaming a make ripples onto its children's denormalized `make` string
//   * renaming a person ripples into every car's designers/engineers text
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

// ---------- fixture ----------
const MK = "mk-test-del", MK2 = "mk-test-del-other";
const FAM = "fam-test-del-alpha", G1 = "m-test-del-a1", G2 = "m-test-del-a2";
const PLAIN = "m-test-del-plain", LLMCAR = "m-test-del-llmcar", OTHER = "m-test-del-other";
const PERSON = "p-test-del-person";

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
    { id: MK, type: "make", label: "TestDelCo", year: 1950 },
    { id: MK2, type: "make", label: "TestOtherCo", year: 1960 },
    // Harvested-looking: no llmGenerated/userAdded flag at all.
    { id: FAM, type: "family", label: "Alpha", make: "TestDelCo", year: 2000, end: null, generations: [G1, G2], designers: ["Del Person"] },
    { id: G1, type: "model", label: "Alpha I", make: "TestDelCo", familyOf: FAM, year: 2000, end: 2010, designers: ["Del Person"] },
    { id: G2, type: "model", label: "Alpha II", make: "TestDelCo", familyOf: FAM, year: 2010, end: null },
    { id: PLAIN, type: "model", label: "Plainy", make: "TestDelCo", year: 2015, end: null },
    // LLM-created: must be reported as NOT hard data.
    { id: LLMCAR, type: "model", label: "Minted", make: "TestDelCo", year: 2020, end: null, llmGenerated: true, llmCreatedNode: true },
    { id: OTHER, type: "model", label: "Elsewhere", make: "TestOtherCo", year: 2015, end: null },
    { id: PERSON, type: "person", kind: "person", label: "Del Person", roles: ["designer"], born: 1960, country: "Testland" },
  );
  DATA.links.push(
    { source: FAM, target: MK, type: "made" }, { source: PLAIN, target: MK, type: "made" },
    { source: LLMCAR, target: MK, type: "made" }, { source: OTHER, target: MK2, type: "made" },
    { source: FAM, target: G1, type: "generation" }, { source: FAM, target: G2, type: "generation" },
    { source: G1, target: PERSON, type: "designed" }, { source: FAM, target: PERSON, type: "designed" },
    { source: PLAIN, target: OTHER, type: "platform" },
  );
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {}, deletions: {}, renames: {}, __serverAvailable: true }, llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  load("platforms.js");
  window.CarWeb.boot();
  window.CarWeb.setYearRange(1900, window.CarWeb.yearRange().max);
  return window;
}

console.log("--- deleting a nameplate takes its generations, and restore brings back exactly those ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  const fam = cw.byId.get(FAM);

  check("harvested data is correctly identified as hard", LF.isHardData(fam));
  check("...and an LLM-minted car is not", !LF.isHardData(cw.byId.get(LLMCAR)));

  const res = LF.deleteNode(fam, cw.nodes, cw.links, "test reason");
  check("delete reports success", res.ok, JSON.stringify(res));
  check("it took the nameplate and both its generations", res.removed === 3, res.removed);
  check("the nameplate is hidden everywhere (nodeInLayer)", !cw.nodeInLayer(fam));
  check("...and so are its generations", !cw.nodeInLayer(cw.byId.get(G1)) && !cw.nodeInLayer(cw.byId.get(G2)));
  check("links touching it are hidden too", cw.links.filter(l =>
    l.sn && l.tn && [l.sn.id, l.tn.id].some(id => [FAM, G1, G2].includes(id))).every(l => !cw.linkInLayer(l)));
  check("it's gone from search", !cw.searchAll("Alpha").some(n => n.id === FAM));
  check("the person's card no longer counts it", !/\b2 cars\b/.test(cw.nodeMeta(cw.byId.get(PERSON))), cw.nodeMeta(cw.byId.get(PERSON)));

  const rec = LF.allDeletions().find(d => d.id === FAM);
  check("the deletion is on record", !!rec);
  check("...flagged as harvested data, which is the half the request asked to be stored", rec && rec.hard === true);
  check("...with the reason kept", rec && rec.reason === "test reason");

  // Nothing was erased -- the nodes are still in the array, just hidden.
  check("nothing was actually erased from the arrays (that's what makes it recoverable)",
    cw.nodes.some(n => n.id === FAM) && cw.nodes.some(n => n.id === G1));

  const back = LF.restoreNode(FAM, cw.nodes, cw.links);
  check("restore reports success", back.ok, JSON.stringify(back));
  check("the nameplate is visible again", cw.nodeInLayer(fam));
  check("...and both generations came back", !cw.byId.get(G1).retired && !cw.byId.get(G2).retired);
  check("its links are live again", cw.links.filter(l =>
    l.sn && l.tn && l.type === "designed" && [l.sn.id, l.tn.id].includes(FAM)).every(l => !l.retired));
  check("the deletion record is gone", !LF.allDeletions().some(d => d.id === FAM));
}

console.log("\n--- deleting a make takes its whole model range ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  const mk = cw.byId.get(MK);
  const res = LF.deleteNode(mk, cw.nodes, cw.links);
  check("delete succeeded", res.ok);
  check("the make is hidden", !cw.nodeInLayer(mk));
  check("every car of that make is hidden too",
    [FAM, G1, G2, PLAIN, LLMCAR].every(id => cw.byId.get(id).retired));
  check("a DIFFERENT make's car is untouched", !cw.byId.get(OTHER).retired);
  LF.restoreNode(MK, cw.nodes, cw.links);
  check("restoring the make brings its whole range back",
    [MK, FAM, G1, G2, PLAIN, LLMCAR].every(id => !cw.byId.get(id).retired));
}

console.log("\n--- restore never resurrects something hidden for a DIFFERENT reason ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;
  // G2 is independently retired first (as a de-dup/override would do), THEN
  // the whole nameplate is deleted. Undoing the hand delete must leave G2's
  // own, unrelated retirement in place.
  const g2 = cw.byId.get(G2);
  g2.retired = true;
  g2.retiredReason = "superseded by something else entirely";
  LF.deleteNode(cw.byId.get(FAM), cw.nodes, cw.links);
  LF.restoreNode(FAM, cw.nodes, cw.links);
  check("the hand-deleted nameplate came back", !cw.byId.get(FAM).retired);
  check("...and its sibling generation came back", !cw.byId.get(G1).retired);
  check("...but the independently-retired one stayed retired", g2.retired === true);
  check("...keeping its own reason, not the delete's", /superseded/.test(g2.retiredReason || ""), g2.retiredReason);
}

console.log("\n--- a delete survives a reload (it's a record, replayed at boot) ---");
{
  const first = freshWindow();
  first.LlmFamilies.deleteNode(first.CarWeb.byId.get(PLAIN), first.CarWeb.nodes, first.CarWeb.links, "gone");
  const persisted = first.LlmFamilies.allDeletions();
  check("something was recorded to persist", persisted.length === 1, persisted.length);

  // Boot fresh with that record in the seed -- exactly what serve.py would
  // hand back on the next page load.
  const second = freshWindow({ deletions: { [PLAIN]: persisted[0] } });
  check("the deleted car is still hidden after a fresh boot", second.CarWeb.byId.get(PLAIN).retired === true);
  check("...and everything else is unaffected", !second.CarWeb.byId.get(FAM).retired);
  // ...and restoring on the fresh boot works just as well.
  second.LlmFamilies.restoreNode(PLAIN, second.CarWeb.nodes, second.CarWeb.links);
  check("restore works on a replayed deletion too", !second.CarWeb.byId.get(PLAIN).retired);
}

console.log("\n--- renaming ---");
{
  const window = freshWindow();
  const cw = window.CarWeb, LF = window.LlmFamilies;

  // A car.
  const plain = cw.byId.get(PLAIN);
  check("rename a car", LF.renameNode(plain, "Renamedy", cw.nodes).ok && plain.label === "Renamedy", plain.label);
  check("...and it's findable under the new name", cw.searchAll("Renamedy").some(n => n.id === PLAIN));

  // A make -- the ripple case: every child carries `make` as a denormalized
  // string, so all of them have to move together.
  const mk = cw.byId.get(MK);
  check("rename a make", LF.renameNode(mk, "TestRenamedCo", cw.nodes).ok && mk.label === "TestRenamedCo", mk.label);
  check("...and every one of its cars now reports the new marque",
    [FAM, G1, G2, PLAIN, LLMCAR].every(id => cw.byId.get(id).make === "TestRenamedCo"),
    JSON.stringify([FAM, PLAIN].map(id => cw.byId.get(id).make)));
  check("...while another make's car is untouched", cw.byId.get(OTHER).make === "TestOtherCo");

  // A person -- their name is also free text inside each car's own
  // designers/engineers array, which the detail card reads.
  const person = cw.byId.get(PERSON);
  check("rename a designer", LF.renameNode(person, "Renamed Person", cw.nodes).ok && person.label === "Renamed Person");
  check("...and the cars' own 'drawn by' text follows",
    (cw.byId.get(G1).designers || []).includes("Renamed Person") &&
    (cw.byId.get(FAM).designers || []).includes("Renamed Person"),
    JSON.stringify(cw.byId.get(G1).designers));

  // Revert goes back to the ORIGINAL, not to whatever was typed last time.
  LF.renameNode(mk, "TestRenamedAgain", cw.nodes);
  check("a second rename still remembers the ORIGINAL name for revert",
    (LF.allRenames().find(r => r.id === MK) || {}).previousLabel === "TestDelCo",
    JSON.stringify(LF.allRenames().find(r => r.id === MK)));
  LF.revertRename(MK, cw.nodes);
  check("revert restores the original make name", mk.label === "TestDelCo", mk.label);
  check("...and un-ripples its children too", cw.byId.get(FAM).make === "TestDelCo", cw.byId.get(FAM).make);
  check("the rename record is gone after reverting", !LF.allRenames().some(r => r.id === MK));
}

console.log("\n--- a rename survives a reload ---");
{
  const first = freshWindow();
  first.LlmFamilies.renameNode(first.CarWeb.byId.get(MK), "PersistedCo", first.CarWeb.nodes);
  const recs = first.LlmFamilies.allRenames();
  const seeded = {}; recs.forEach(r => { seeded[r.id] = r; });
  const second = freshWindow({ renames: seeded });
  check("the renamed make keeps its new name after a fresh boot", second.CarWeb.byId.get(MK).label === "PersistedCo");
  check("...and its children still report it", second.CarWeb.byId.get(FAM).make === "PersistedCo");
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
