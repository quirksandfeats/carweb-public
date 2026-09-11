// Real bug report (Mercedes-Benz G-Class case): checking the G-Class found
// real shared-platform/related connections for its specific generations
// (e.g. W463 <-> Sprinter) -- visible in that generation's own detail panel,
// a real graph link -- but the collapsed G-Class nameplate itself showed
// nothing: no line connects the visible "G-Class" dot to anything until you
// expand it. Root cause: applyResolvedRelations only ever wires the specific
// generation<->target link, and only RETAGS an existing family-level
// connection as a "mirror" if one already happened to exist from a prior
// build-time DBpedia harvest -- a relation the LLM discovers fresh, with no
// build-time equivalent, never gets a family-level stand-in at all.
// mirrorRelationLinks (llm_families.js) is the fix: same reasoning and same
// link shape as build_family_layer.py's own mirror_relation_links() already
// uses for build-time links, just applied to links added at runtime too.
// This test proves the family-level mirror link now gets created end to
// end, and that a second apply pass doesn't create a duplicate.
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
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
const GWAGEN_ID = "m-test-mirror-gwagen";
const SPRINTER_ID = "m-test-mirror-sprinter";

let mk1 = DATA.nodes.find(n => n.type === "make" && n.label === "TestMirrorMB");
if (!mk1) { mk1 = { id: "mk-test-mirror-mb", type: "make", label: "TestMirrorMB", year: 1950 }; DATA.nodes.push(mk1); }
let mk2 = DATA.nodes.find(n => n.type === "make" && n.label === "TestMirrorOther");
if (!mk2) { mk2 = { id: "mk-test-mirror-other", type: "make", label: "TestMirrorOther", year: 1950 }; DATA.nodes.push(mk2); }

const gwagen = { id: GWAGEN_ID, type: "model", label: "Gwagenish", make: "TestMirrorMB", wp: "TestMirror Gwagenish", year: 1979, end: null };
const sprinter = { id: SPRINTER_ID, type: "model", label: "Sprinterish", make: "TestMirrorOther", year: 1995, end: null };
DATA.nodes.push(gwagen, sprinter);
DATA.links.push(
  { source: GWAGEN_ID, target: mk1.id, type: "made" },
  { source: SPRINTER_ID, target: mk2.id, type: "made" },
);

// Pre-seed an already-"confirmed" multi-generation split for Gwagenish,
// where the FIRST generation's own article text names "Sprinterish" as an
// exact, unambiguous shared-platform mention -- resolveOnePlatformMention's
// exact-match branch (a plain-model target) auto-confirms this immediately,
// no interactive click needed, so this test exercises applyConfirmed's own
// resolvePlatformMention call plus applyResolvedRelations' real code path
// end to end, without needing a live LLM call.
window.LLM_FAMILIES = {
  families: {
    [GWAGEN_ID]: {
      status: "confirmed",
      sourceTitle: "TestMirror Gwagenish",
      checkedAt: new Date().toISOString(),
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "W463ish", yearStart: 1990, yearEnd: 2018, designers: [], engineers: [], sharedPlatforms: ["Sprinterish"] },
          { code: "W465ish", yearStart: 2018, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] },
        ],
      },
    },
  },
  relations: {}, recheck: {}, __serverAvailable: true,
};
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

const gwagenFresh = cw.byId.get(GWAGEN_ID);
check("Gwagenish became a real family via the confirmed split", gwagenFresh && gwagenFresh.type === "family", gwagenFresh);

const w463 = cw.nodes.find(n => n.familyOf === GWAGEN_ID && (n.label || "").includes("W463ish"));
check("W463ish generation node exists", !!w463, w463 && w463.id);

// The specific generation<->model link -- this already worked before this fix.
const genLink = cw.links.find(l => l.type === "platform" && l.llmResolved &&
  ((l.sn === w463 && l.tn === sprinter) || (l.sn === sprinter && l.tn === w463)));
check("specific generation<->Sprinterish link exists (already worked before this fix)", !!genLink, genLink);

// The NEW family-level mirror -- this is the actual fix.
const mirrorLink = cw.links.find(l => l.type === "platform" && l.mirror &&
  ((l.sn === gwagenFresh && l.tn === sprinter) || (l.sn === sprinter && l.tn === gwagenFresh)));
check("family-level MIRROR link now exists (Gwagenish family <-> Sprinterish) -- the actual fix", !!mirrorLink, mirrorLink);
check("mirror is tagged mirrorSourceFam pointing at the Gwagenish family (so app.js's collapse/expand precedence rule can find it)",
  mirrorLink && mirrorLink.mirrorSourceFam === GWAGEN_ID, mirrorLink);
check("mirror carries no mirrorTargetFam (Sprinterish is a plain model, not folded into any family of its own)",
  mirrorLink && !mirrorLink.mirrorTargetFam, mirrorLink);

// Idempotency: re-running the apply pass (as every subsequent live-apply
// call site in app.js does) must never create a second, duplicate mirror.
// Scoped to just this test's own Gwagenish<->Sprinterish pair -- the real
// production dataset (loaded via data.js above) already carries ~20
// pre-existing build-time mirror links of its own, so counting ALL mirror
// links in the graph isn't a meaningful idempotency signal here.
const mirrorsForPair = () => cw.links.filter(l => l.type === "platform" && l.mirror &&
  ((l.sn === gwagenFresh && l.tn === sprinter) || (l.sn === sprinter && l.tn === gwagenFresh)));
const before = mirrorsForPair().length;
window.LlmFamilies.applyResolvedRelations(cw.nodes, cw.links);
const after = mirrorsForPair().length;
check("re-running applyResolvedRelations doesn't create a duplicate mirror for this pair", before === 1 && after === 1, { before, after });

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
