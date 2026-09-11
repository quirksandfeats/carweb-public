// Verifies a real bug report: after clicking "Clear ALL" in the LLM debug
// panel and reloading, BMW X3 kept showing two already-verified relation
// matches ("✓ X3 G45/NA5 ↔ BMW iX3 (NA5) (succession)", "✓ X3 ↔ BMW X4 G02
// (related)") as if the reset had silently done nothing. Root cause:
// resetAll() only ever wiped store.families and store.recheck -- the THIRD
// persisted layer, store.relations (see checkRelation/resolvePlatformMention
// in llm_families.js), was never touched, so every relation resolution the
// LLM had ever confirmed survived a "Clear ALL" and kept re-creating its
// link + re-showing its confirmation on every future boot. Same gap existed
// in deleteEntry/deleteRecheckEntry: deleting one nameplate left any
// relation resolution touching it dangling in store.relations.
//
// Fix verified here: resetAll() now wipes store.relations too, and
// deleteEntry/deleteRecheckEntry now purge (scoped, not wholesale) any
// relation entry that touches the deleted id on either side.
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
function relKey(a, b, relType) { return [a, b].sort().join("|") + "|" + relType; }

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

let posts = [];
window.fetch = (url, opts) => {
  if (url === "/api/llm-families" && opts && opts.method === "POST") {
    posts.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let makeNode = { id: "mk-test-purge", type: "make", label: "TestBMW-purge", year: 1916 };
DATA.nodes.push(makeNode);

// ---------- BMW-X3-shaped seed: a family with an APPLIED recheck override
// AND two live-resolved relation matches to two other nameplates -- the
// exact real-world shape from the bug report ----------
const FAM_X3_ID = "fam-test-purge-nx3", BARE_ID = "m-test-purge-nx3-bare", G45_ID = "m-test-purge-nx3-g45";
const FAM_IX3_ID = "fam-test-purge-nix3", NA5_ID = "m-test-purge-nix3-na5";
const FAM_X4_ID = "fam-test-purge-nx4", G02_ID = "m-test-purge-nx4-g02";

const famX3 = { id: FAM_X3_ID, type: "family", label: "NX3", make: "TestBMW-purge", year: 2003, end: null, designers: [], engineers: [], generations: [BARE_ID, G45_ID] };
const bareGen = { id: BARE_ID, type: "model", label: "NX3", make: "TestBMW-purge", year: 2003, end: 2024, familyOf: FAM_X3_ID, wp: "TestBMW-purge NX3", designers: [], engineers: [] };
const g45Gen = { id: G45_ID, type: "model", label: "NX3 G45/NA5", make: "TestBMW-purge", year: 2024, end: null, familyOf: FAM_X3_ID, designers: [], engineers: [] };
const famIx3 = { id: FAM_IX3_ID, type: "family", label: "NiX3", make: "TestBMW-purge", year: 2024, end: null, designers: [], engineers: [], generations: [NA5_ID] };
const na5Gen = { id: NA5_ID, type: "model", label: "NiX3 (NA5)", make: "TestBMW-purge", year: 2024, end: null, familyOf: FAM_IX3_ID, designers: [], engineers: [] };
const famX4 = { id: FAM_X4_ID, type: "family", label: "NX4", make: "TestBMW-purge", year: 2014, end: null, designers: [], engineers: [], generations: [G02_ID] };
const g02Gen = { id: G02_ID, type: "model", label: "NX4 G02", make: "TestBMW-purge", year: 2018, end: null, familyOf: FAM_X4_ID, designers: [], engineers: [] };

// ---------- an UNRELATED pair, to prove the purge is scoped, not wholesale ----------
const FAM_U1_ID = "fam-test-purge-uno", U1G_ID = "m-test-purge-uno-g1";
const FAM_U2_ID = "fam-test-purge-duo", U2G_ID = "m-test-purge-duo-g1";
const famU1 = { id: FAM_U1_ID, type: "family", label: "Uno", make: "TestBMW-purge", year: 2000, end: null, designers: [], engineers: [], generations: [U1G_ID] };
const u1Gen = { id: U1G_ID, type: "model", label: "Uno G1", make: "TestBMW-purge", year: 2000, end: null, familyOf: FAM_U1_ID, designers: [], engineers: [] };
const famU2 = { id: FAM_U2_ID, type: "family", label: "Duo", make: "TestBMW-purge", year: 2000, end: null, designers: [], engineers: [], generations: [U2G_ID] };
const u2Gen = { id: U2G_ID, type: "model", label: "Duo G1", make: "TestBMW-purge", year: 2000, end: null, familyOf: FAM_U2_ID, designers: [], engineers: [] };

// ---------- a plain-model, store.families-layer entry (exercises deleteEntry's own purge, not just deleteRecheckEntry's) ----------
const FAM_PLAIN_ID = "m-test-purge-plainmodel";
const plainModel = { id: FAM_PLAIN_ID, type: "model", label: "PlainNP", make: "TestBMW-purge", year: 2005, end: null, wp: "TestBMW-purge PlainNP" };

DATA.nodes.push(famX3, bareGen, g45Gen, famIx3, na5Gen, famX4, g02Gen, famU1, u1Gen, famU2, u2Gen, plainModel);
[FAM_X3_ID, FAM_IX3_ID, FAM_X4_ID, FAM_U1_ID, FAM_U2_ID, FAM_PLAIN_ID].forEach(id => DATA.links.push({ source: id, target: makeNode.id, type: "made" }));
DATA.links.push({ source: FAM_X3_ID, target: BARE_ID, type: "generation" }, { source: FAM_X3_ID, target: G45_ID, type: "generation" }, { source: BARE_ID, target: G45_ID, type: "gensucc" });
DATA.links.push({ source: FAM_IX3_ID, target: NA5_ID, type: "generation" });
DATA.links.push({ source: FAM_X4_ID, target: G02_ID, type: "generation" });
DATA.links.push({ source: FAM_U1_ID, target: U1G_ID, type: "generation" });
DATA.links.push({ source: FAM_U2_ID, target: U2G_ID, type: "generation" });
// Coarse, build-time-style undisambiguated facts.
DATA.links.push({ source: FAM_X3_ID, target: FAM_IX3_ID, type: "succession" });
DATA.links.push({ source: FAM_X3_ID, target: FAM_X4_ID, type: "related" });
DATA.links.push({ source: FAM_U1_ID, target: FAM_U2_ID, type: "platform" });
DATA.links.push({ source: FAM_PLAIN_ID, target: FAM_U1_ID, type: "platform" });

// Snapshot the seed data BEFORE app.js/CarWeb.boot() ever runs -- d3-force
// mutates every link's source/target from a plain string id into a direct
// node OBJECT reference the moment a simulation runs (the well-known
// "link.source/target string->object-reference" gotcha this codebase works
// around everywhere else), and DATA.links is the exact same array app.js's
// d3 simulation operates on. Cloning DATA *after* boot for the second,
// fresh-boot window below would silently carry that mutation over and break
// the second window's own byId/adj indexing.
const SEED_SNAPSHOT = JSON.parse(JSON.stringify(DATA));

const KEY_SUCC = relKey(FAM_X3_ID, FAM_IX3_ID, "succession");
const KEY_REL = relKey(FAM_X3_ID, FAM_X4_ID, "related");
const KEY_UNRELATED = relKey(FAM_U1_ID, FAM_U2_ID, "platform");
const KEY_PLAIN = relKey(FAM_PLAIN_ID, FAM_U1_ID, "platform");

window.LLM_FAMILIES = {
  families: {
    [FAM_PLAIN_ID]: {
      status: "confirmed", checkedAt: new Date().toISOString(), sourceTitle: "TestBMW-purge PlainNP",
      proposal: { hasMultipleGenerations: false, generations: [] }, allDesigners: [], allEngineers: [], attempts: 1, feedback: [],
    },
  },
  recheck: {
    [FAM_X3_ID]: {
      status: "applied", checkedAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
      sourceTitle: "TestBMW-purge NX3", proposal: { hasMultipleGenerations: true, generations: [] }, discrepancy: null,
      attempts: 1, feedback: [],
    },
  },
  relations: {
    [KEY_SUCC]: {
      status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      famA: FAM_X3_ID, famB: FAM_IX3_ID, relType: "succession", matchLevel: "generation",
      codeA: "NX3 G45/NA5", codeB: "NiX3 (NA5)", genIdA: G45_ID, genIdB: NA5_ID, reason: "test seed",
    },
    [KEY_REL]: {
      status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      famA: FAM_X3_ID, famB: FAM_X4_ID, relType: "related", matchLevel: "nameplate",
      codeA: "NX3", codeB: "NX4 G02", genIdA: FAM_X3_ID, genIdB: G02_ID, reason: "test seed",
    },
    [KEY_UNRELATED]: {
      status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      famA: FAM_U1_ID, famB: FAM_U2_ID, relType: "platform", matchLevel: "generation",
      codeA: "Uno G1", codeB: "Duo G1", genIdA: U1G_ID, genIdB: U2G_ID, reason: "test seed",
    },
    [KEY_PLAIN]: {
      status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      famA: FAM_PLAIN_ID, famB: FAM_U1_ID, relType: "platform", matchLevel: "nameplate",
      codeA: "PlainNP", codeB: "Uno", genIdA: FAM_PLAIN_ID, genIdB: FAM_U1_ID, reason: "test seed",
    },
  },
  __serverAvailable: true,
};
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
  loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
const LF = window.LlmFamilies;

console.log("--- precondition: everything shows up before any delete/reset ---");
check("all 4 relation entries present at boot", LF.allRelationEntries().length === 4, LF.allRelationEntries().length);
check("X3's recheck override is 'applied'", LF.recheckEntryFor(FAM_X3_ID) && LF.recheckEntryFor(FAM_X3_ID).status === "applied");
check("PlainNP's generation-check entry is 'confirmed'", LF.entryFor(FAM_PLAIN_ID) && LF.entryFor(FAM_PLAIN_ID).status === "confirmed");

const x3 = cw.byId.get(FAM_X3_ID);
cw.openDetail(x3);
const resolvedLines = [...window.document.querySelectorAll(".dt-relations .llm-resolved")].map(d => d.textContent);
check("BOTH real bug-report resolved lines render on X3's panel", resolvedLines.length === 2, JSON.stringify(resolvedLines));
check("...the succession match specifically", resolvedLines.some(t => t.includes("NA5") && t.includes("succession")), JSON.stringify(resolvedLines));
check("...the related match specifically", resolvedLines.some(t => t.includes("NX4 G02") && t.includes("related")), JSON.stringify(resolvedLines));

console.log("\n--- deleteRecheckEntry(X3): should purge ONLY X3's two relation entries ---");
(async () => {
  await LF.deleteRecheckEntry(FAM_X3_ID);
  check("X3's recheck entry is gone", LF.recheckEntryFor(FAM_X3_ID) === null);
  const afterX3Delete = LF.allRelationEntries();
  check("X3's succession relation entry purged", !afterX3Delete.some(e => e.id === KEY_SUCC), JSON.stringify(afterX3Delete.map(e => e.id)));
  check("X3's related relation entry purged", !afterX3Delete.some(e => e.id === KEY_REL), JSON.stringify(afterX3Delete.map(e => e.id)));
  check("UNRELATED entry (Uno<->Duo) survives -- purge is scoped, not wholesale", afterX3Delete.some(e => e.id === KEY_UNRELATED));
  check("PlainNP's own relation entry survives too (untouched by X3's delete)", afterX3Delete.some(e => e.id === KEY_PLAIN));
  const lastPost = posts[posts.length - 1];
  check("the purge was actually persisted to disk (not just in-memory)",
    lastPost && !(KEY_SUCC in lastPost.relations) && !(KEY_REL in lastPost.relations) && (KEY_UNRELATED in lastPost.relations));

  // ---------- prove it from the other end: a FRESH boot from the just-persisted disk state ----------
  console.log("\n--- fresh boot from the persisted (post-delete) state: this is what a real reload does ---");
  const dom2 = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const window2 = dom2.window;
  window2.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window2.requestAnimationFrame = () => 1;
  window2.devicePixelRatio = 1;
  window2.Element.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect;
  Object.defineProperty(window2.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window2.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window2.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  const savedWindow = global.window, savedDocument = global.document;
  global.window = window2; global.document = window2.document;
  window2.eval(fs.readFileSync(path.join(APP, "d3.min.js"), "utf-8"));
  window2.CARDATA = JSON.parse(JSON.stringify(SEED_SNAPSHOT)); // fresh, pre-boot copy of the same seeded build-time data
  window2.LLM_FAMILIES = Object.assign({}, JSON.parse(JSON.stringify(lastPost)), { __serverAvailable: true });
  window2.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "app.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "timeline.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "sixdeg.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "platforms.js"), "utf-8"));
  window2.CarWeb.boot();
  const x3_2 = window2.CarWeb.byId.get(FAM_X3_ID);
  window2.CarWeb.openDetail(x3_2);
  const resolvedLines2 = [...window2.document.querySelectorAll(".dt-relations .llm-resolved")].map(d => d.textContent);
  check("REAL BUG REPORT, now fixed: after a fresh reload from the post-delete state, X3 shows NO leftover resolved-relation lines",
    resolvedLines2.length === 0, JSON.stringify(resolvedLines2));
  global.window = savedWindow; global.document = savedDocument;

  // ---------- deleteEntry(PlainNP): should purge ONLY PlainNP's own relation entry ----------
  console.log("\n--- deleteEntry(PlainNP): should purge ONLY PlainNP's relation entry ---");
  await LF.deleteEntry(FAM_PLAIN_ID);
  check("PlainNP's generation-check entry is gone", LF.entryFor(FAM_PLAIN_ID) === null);
  const afterPlainDelete = LF.allRelationEntries();
  check("PlainNP's relation entry purged", !afterPlainDelete.some(e => e.id === KEY_PLAIN), JSON.stringify(afterPlainDelete.map(e => e.id)));
  check("UNRELATED entry (Uno<->Duo) still survives", afterPlainDelete.some(e => e.id === KEY_UNRELATED));
  check("exactly one relation entry left (Uno<->Duo)", afterPlainDelete.length === 1, afterPlainDelete.length);

  // ---------- resetAll(): should wipe EVERYTHING, including whatever relations remain ----------
  console.log("\n--- resetAll() (Clear ALL): should wipe every layer, including store.relations ---");
  await LF.resetAll();
  check("allEntries() (families layer) empty", LF.allEntries().length === 0);
  check("allRecheckEntries() (recheck layer) empty", LF.allRecheckEntries().length === 0);
  check("allRelationEntries() (relations layer) empty -- the exact layer the original bug report left untouched",
    LF.allRelationEntries().length === 0, LF.allRelationEntries().length);
  const finalPost = posts[posts.length - 1];
  check("resetAll() persisted an empty relations store to disk too",
    finalPost && finalPost.relations && Object.keys(finalPost.relations).length === 0);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
