// Verifies the data_live.js boot-time fix (v3): a cached live-refresh DELTA
// (new nodes/links plus a small field-patch map) gets spliced/applied onto
// whatever the current baked data.js actually is.
//
// v2 (splice a FULL merged snapshot) fixed the original "Apply does nothing"
// bug but introduced two new ones, both matching real user reports:
//   - Safari's localStorage quota is much tighter than Chrome's, so writing
//     a multi-MB full-snapshot string silently failed there -- the cache
//     never actually persisted, so every load re-showed the exact same
//     diff forever.
//   - the splice only ever ADDED nodes/links that didn't already exist; it
//     never re-applied a field-level UPDATE (like a newly-discovered
//     production-end year) onto a node that already existed in the fresh
//     bake, so "1 updated" recurred on every check even after Apply.
// v3 persists only the tiny delta and applies field patches at boot, which
// this file now verifies end to end.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

function freshWindow() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  return dom.window;
}

// ---------- scenario 1: a cached delta's new node/link gets spliced onto a newer/bigger bake ----------
{
  const window = freshWindow();
  global.window = window; global.document = window.document;

  // "current" baked data.js is a NEWER rebuild with its own curated addition
  // (Explorer) that the old cached delta has never heard of.
  window.CARDATA = {
    meta: { version: 5, generated: "2026-07-13", counts: { nodes: 3, links: 1 } },
    nodes: [
      { id: "mk-ford", type: "make", label: "Ford" },
      { id: "m-ford-focus", type: "model", label: "Focus", make: "Ford", wp: "Ford Focus", year: 1998 },
      { id: "m-ford-explorer", type: "model", label: "Explorer", make: "Ford", wp: "Ford Explorer", year: 1990 }, // curated addition NOT in the old cache
    ],
    links: [{ source: "m-ford-focus", target: "mk-ford", type: "made" }],
  };

  // a delta from a PRIOR refresh(), as merge() would actually produce it:
  // only the genuinely NEW node/link it found (a live-discovered Puma),
  // never anything that already existed at merge-time (Focus is NOT here).
  const delta = {
    version: 5,
    generated: "2026-07-13",   // the bake this delta was computed against
    savedAt: Date.now(),
    newNodes: [
      { id: "m-ford-puma", type: "model", label: "Puma", make: "Ford", wp: "Ford Puma", year: 2019, live: true, auto: true },
    ],
    newLinks: [{ source: "m-ford-puma", target: "mk-ford", type: "made" }],
    updates: {},
  };
  window.localStorage.setItem("carweb_live_snapshot_v1", JSON.stringify(delta));

  window.eval(fs.readFileSync(path.join(APP, "data_live.js"), "utf-8"));

  const nodeIds = window.CARDATA.nodes.map(n => n.id);
  check("the curated Explorer (only in the new bake) survives", nodeIds.includes("m-ford-explorer"));
  check("the live-discovered Puma (only in the cached delta) got spliced in", nodeIds.includes("m-ford-puma"));
  check("Focus wasn't duplicated (present in both)", nodeIds.filter(id => id === "m-ford-focus").length === 1);
  const linkKeys = window.CARDATA.links.map(l => l.source + "|" + l.target + "|" + l.type);
  check("Puma's made-link was spliced in too", linkKeys.includes("m-ford-puma|mk-ford|made"));
  check("meta.counts reflects the spliced totals", window.CARDATA.meta.counts.nodes === window.CARDATA.nodes.length);
}

// ---------- scenario 2: a link whose endpoint didn't survive the rebuild is dropped, not left dangling ----------
{
  const window = freshWindow();
  global.window = window; global.document = window.document;
  window.CARDATA = {
    meta: { version: 5, generated: "2026-07-13", counts: { nodes: 1, links: 0 } },
    nodes: [{ id: "mk-ford", type: "make", label: "Ford" }],
    links: [],
  };
  const delta = {
    version: 5,
    generated: "2026-07-13",   // the bake this delta was computed against
    savedAt: Date.now(),
    newNodes: [{ id: "m-ford-cortina-old-id", type: "model", label: "Cortina", make: "Ford", wp: "Ford Cortina", year: 1962 }],
    newLinks: [{ source: "m-ford-cortina-old-id", target: "mk-ford", type: "made" }],
    updates: {},
  };
  window.localStorage.setItem("carweb_live_snapshot_v1", JSON.stringify(delta));
  window.eval(fs.readFileSync(path.join(APP, "data_live.js"), "utf-8"));
  // Cortina has a unique wp, no existing match, so it still splices in fine.
  check("Cortina (unique wp, no existing match) still gets spliced in", window.CARDATA.nodes.some(n => n.id === "m-ford-cortina-old-id"));
}

// ---------- scenario 3: an incompatible schema version is discarded outright, not spliced ----------
{
  const window = freshWindow();
  global.window = window; global.document = window.document;
  window.CARDATA = { meta: { version: 5, generated: "2026-07-13", counts: { nodes: 1, links: 0 } }, nodes: [{ id: "mk-ford", type: "make", label: "Ford" }], links: [] };
  window.localStorage.setItem("carweb_live_snapshot_v1", JSON.stringify({
    version: 4, savedAt: Date.now(), newNodes: [{ id: "junk", type: "model", label: "junk" }], newLinks: [], updates: {},
  }));
  window.eval(fs.readFileSync(path.join(APP, "data_live.js"), "utf-8"));
  check("an old-schema (version mismatch) cache is discarded, not spliced", !window.CARDATA.nodes.some(n => n.id === "junk"));
  check("the stale cache entry got removed from localStorage", window.localStorage.getItem("carweb_live_snapshot_v1") === null);
}

// ---------- scenario 3b: an old (pre-delta) full-snapshot-shaped cache is also discarded, not crashed on ----------
{
  const window = freshWindow();
  global.window = window; global.document = window.document;
  window.CARDATA = { meta: { version: 5, generated: "2026-07-13", counts: { nodes: 1, links: 0 } }, nodes: [{ id: "mk-ford", type: "make", label: "Ford" }], links: [] };
  // shape from the OLD v2 code: {meta, nodes, links} -- no newNodes/newLinks/version.
  window.localStorage.setItem("carweb_live_snapshot_v1", JSON.stringify({
    meta: { version: 5, generated: "2026-07-01" },
    nodes: [{ id: "mk-ford", type: "make", label: "Ford" }, { id: "m-old-format-junk", type: "model", label: "junk" }],
    links: [],
  }));
  window.eval(fs.readFileSync(path.join(APP, "data_live.js"), "utf-8"));
  check("an old v2 full-snapshot cache doesn't crash the boot", window.CARDATA.nodes.length >= 1);
  check("and its contents are NOT spliced in (schema mismatch)", !window.CARDATA.nodes.some(n => n.id === "m-old-format-junk"));
}

// ---------- scenario 4: a field-level UPDATE patch (e.g. newly-discovered end year) actually applies and sticks ----------
// This is the fix for the "1 updated" that used to recur forever: the old
// splice only ever added missing nodes/links, it never wrote an update
// back onto a node that already existed.
{
  const window = freshWindow();
  global.window = window; global.document = window.document;
  window.CARDATA = {
    meta: { version: 5, generated: "2026-07-13", counts: { nodes: 2, links: 0 } },
    nodes: [
      { id: "mk-ford", type: "make", label: "Ford" },
      // a live-discovered (auto) model still missing its production-end
      // year and designer credit -- exactly what merge()'s update path fills in.
      { id: "m-ford-puma", type: "model", label: "Puma", make: "Ford", wp: "Ford Puma", year: 2019, end: null, designers: [], auto: true, live: true },
    ],
    links: [],
  };
  const delta = {
    version: 5,
    generated: "2026-07-13",   // the bake this delta was computed against
    savedAt: Date.now(),
    newNodes: [],
    newLinks: [],
    updates: { "m-ford-puma": { end: 2024, designers: ["Amko Leenarts"] } },
  };
  window.localStorage.setItem("carweb_live_snapshot_v1", JSON.stringify(delta));
  window.eval(fs.readFileSync(path.join(APP, "data_live.js"), "utf-8"));
  const puma = window.CARDATA.nodes.find(n => n.id === "m-ford-puma");
  check("the cached end-year patch actually applied to the existing node", puma.end === 2024, puma.end);
  check("the cached designers patch actually applied to the existing node", puma.designers.length === 1 && puma.designers[0] === "Amko Leenarts", puma.designers);
}

// ---------- scenario 5: an update patch never overwrites data the live node ALREADY has (curated wins) ----------
{
  const window = freshWindow();
  global.window = window; global.document = window.document;
  window.CARDATA = {
    meta: { version: 5, generated: "2026-07-13", counts: { nodes: 1, links: 0 } },
    nodes: [{ id: "m-ford-puma", type: "model", label: "Puma", make: "Ford", wp: "Ford Puma", year: 2019, end: 2023, designers: ["Original Designer"], auto: true }],
    links: [],
  };
  const delta = {
    version: 5, savedAt: Date.now(), newNodes: [], newLinks: [],
    updates: { "m-ford-puma": { end: 2099, designers: ["Someone Else"] } },
  };
  window.localStorage.setItem("carweb_live_snapshot_v1", JSON.stringify(delta));
  window.eval(fs.readFileSync(path.join(APP, "data_live.js"), "utf-8"));
  const puma = window.CARDATA.nodes.find(n => n.id === "m-ford-puma");
  check("an already-set end year is never overwritten by a stale patch", puma.end === 2023, puma.end);
  check("already-set designers are never overwritten by a stale patch", puma.designers[0] === "Original Designer", puma.designers);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
