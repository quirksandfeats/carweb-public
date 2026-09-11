// Second wave of de-duplication coverage (real bug report): after LLM-
// confirming a nameplate's full generation list, a PRE-EXISTING duplicate
// still stuck around in two cases the original de-dup fix
// (jsdom_family_dedup_test.js) never covered:
//
//   1. The duplicate's own label names MORE than one designation at once,
//      e.g. Wikipedia/DBpedia filed "R107" and "C107" together as one
//      combined resource labeled "R107 and C107" -- the LLM's own
//      extracted code is just "R107", which never exactly matched the
//      combined label as a whole, so the old node was never recognized as
//      a duplicate at all and stayed fully visible forever.
//   2. The duplicate is already a GENERATION of some OTHER, earlier
//      (build-time) family, not a standalone model -- e.g. the real
//      Mercedes-Benz SL-Class case: build-time grouping had already filed
//      R129/R230/R231 under one family from a shared "SL-Class (<code>)"
//      label pattern, but a LATER, more thorough LLM read of the plain
//      "SL-Class" overview article found ALL FOUR generations (R107
//      included) and, since the old de-dup search explicitly skipped
//      anything with a `familyOf` already set, minted a second, fully
//      duplicate family instead of recognizing the build-time ones as the
//      same cars.
//
// Also verifies the natural follow-on: once EVERY one of an old family's
// generations has been superseded this way, the old family itself (now an
// empty husk) is retired too, not left as a visible-but-empty dot.
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
const lid = v => (typeof v === "string" ? v : v && v.id);

// ---------- ids ----------
const OLD_FAM_ID = "fam-test-dd2-sl";
const OLD_R129_ID = "m-test-dd2-sl-r129", OLD_R230_ID = "m-test-dd2-sl-r230", OLD_R231_ID = "m-test-dd2-sl-r231";
const COMBINED_ID = "m-test-dd2-r107-and-c107"; // deliberately a combined label, NOT an exact "R107" match
const OVERVIEW_ID = "m-test-dd2-sl-overview"; // the plain nameplate node that gets LLM-confirmed
const OTHER_ID = "m-test-dd2-928";
const DESIGNER_ID = "p-test-dd2-old-designer";
// A totally different, unrelated nameplate from the SAME manufacturer that
// happens to reuse the exact same chassis code "R230" for one of its own
// generations -- real report this guards against: BMW's own G01 is the X3,
// but G02 is a completely different nameplate (the X4); a bare-code match
// with no check on the BASE nameplate name wrongly conflated them.
const UNRELATED_FAM_ID = "fam-test-dd2-gclass", UNRELATED_GEN_ID = "m-test-dd2-gclass-r230";

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
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMercedes-dd2");
if (!makeNode) { makeNode = { id: "mk-test-dd2", type: "make", label: "TestMercedes-dd2", year: 1926 }; DATA.nodes.push(makeNode); }

// Build-time family with THREE generations already grouped under it.
const oldFam = { id: OLD_FAM_ID, type: "family", label: "SL-Class", make: "TestMercedes-dd2", year: 1989, end: null, designers: [], engineers: [], generations: [OLD_R129_ID, OLD_R230_ID, OLD_R231_ID] };
const oldR129 = { id: OLD_R129_ID, type: "model", label: "SL-Class (R129)", make: "TestMercedes-dd2", year: 1989, end: 2001, familyOf: OLD_FAM_ID, wp: "TestMercedes SL-Class (R129)", designers: [] };
const oldR230 = { id: OLD_R230_ID, type: "model", label: "SL-Class (R230)", make: "TestMercedes-dd2", year: 2001, end: 2011, familyOf: OLD_FAM_ID, wp: "TestMercedes SL-Class (R230)", designers: [] };
const oldR231 = { id: OLD_R231_ID, type: "model", label: "SL-Class (R231)", make: "TestMercedes-dd2", year: 2012, end: 2020, familyOf: OLD_FAM_ID, wp: "TestMercedes SL-Class (R231)", designers: [] };
// Combined-label standalone, mirroring the real "R107 and C107" DBpedia resource.
const combined = { id: COMBINED_ID, type: "model", label: "R107 and C107", make: "TestMercedes-dd2", year: 1971, end: 1989,
  wp: "TestMercedes R107 and C107", designers: ["Old Combined Designer"], db: true, dbspecs: { modelYear: "1985" }, garage: true };
// The plain overview node about to be LLM-confirmed with all four
// generations -- labeled bare "SL-Class", matching this app's real
// convention (build_family_layer.py's own generation labels are always
// "<this exact label> (<code>)"), which is what makes tier 3's base-name
// check in findDuplicateGeneration actually line up.
const overview = { id: OVERVIEW_ID, type: "model", label: "SL-Class", make: "TestMercedes-dd2", year: 1954, end: null, wp: "TestMercedes SL-Class" };
const other = { id: OTHER_ID, type: "model", label: "Test928-dd2", make: "TestMercedes-dd2", year: 1978, end: 1995 };
const designer = { id: DESIGNER_ID, type: "person", kind: "person", label: "Old Combined Designer", roles: ["designer"], born: null, died: null, country: null, wp: null };
const unrelatedFam = { id: UNRELATED_FAM_ID, type: "family", label: "G-Class", make: "TestMercedes-dd2", year: 2015, end: null, designers: [], engineers: [], generations: [UNRELATED_GEN_ID] };
const unrelatedGen = { id: UNRELATED_GEN_ID, type: "model", label: "G-Class (R230)", make: "TestMercedes-dd2", year: 2015, end: null, familyOf: UNRELATED_FAM_ID, wp: "TestMercedes G-Class (R230)" };

DATA.nodes.push(oldFam, oldR129, oldR230, oldR231, combined, overview, other, designer, unrelatedFam, unrelatedGen);
DATA.links.push({ source: OLD_FAM_ID, target: makeNode.id, type: "made" }, { source: COMBINED_ID, target: makeNode.id, type: "made" }, { source: OVERVIEW_ID, target: makeNode.id, type: "made" }, { source: OTHER_ID, target: makeNode.id, type: "made" }, { source: UNRELATED_FAM_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: UNRELATED_FAM_ID, target: UNRELATED_GEN_ID, type: "generation" });
DATA.links.push({ source: OLD_FAM_ID, target: OLD_R129_ID, type: "generation" }, { source: OLD_FAM_ID, target: OLD_R230_ID, type: "generation" }, { source: OLD_FAM_ID, target: OLD_R231_ID, type: "generation" });
DATA.links.push({ source: OLD_R129_ID, target: OLD_R230_ID, type: "gensucc" }, { source: OLD_R230_ID, target: OLD_R231_ID, type: "gensucc" });
DATA.links.push({ source: OLD_R230_ID, target: DESIGNER_ID, type: "designed", note: "test-old-family-designer" }); // proves a family-grouped duplicate's own links get rebound too
DATA.links.push({ source: COMBINED_ID, target: OTHER_ID, type: "related", note: "test-combined-related" }); // proves the combined-label duplicate's own links get rebound too
DATA.links.push({ source: COMBINED_ID, target: DESIGNER_ID, type: "designed" });

// The LLM's fresh, thorough read of the plain overview article: ALL FOUR
// real generations, including the two kinds of pre-existing duplicate above.
window.LLM_FAMILIES = {
  families: {
    [OVERVIEW_ID]: {
      status: "confirmed", checkedAt: new Date().toISOString(), sourceTitle: "TestMercedes SL-Class",
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "R107", yearStart: null, yearEnd: null, designers: [], engineers: [] }, // combined-label duplicate
          { code: "R129", yearStart: 1989, yearEnd: 2001, designers: [], engineers: [] }, // family-grouped duplicate
          { code: "R230", yearStart: 2001, yearEnd: 2011, designers: [], engineers: [] }, // family-grouped duplicate
          { code: "R231", yearStart: 2012, yearEnd: 2020, designers: [], engineers: [] }, // family-grouped duplicate
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

const newFam = cw.byId.get(OVERVIEW_ID);
check("the overview node became a family in place", !!newFam && newFam.type === "family", newFam && newFam.type);
check("it minted all 4 generations", newFam && newFam.generations && newFam.generations.length === 4, newFam && newFam.generations);

const newR107 = (newFam.generations || []).map(id => cw.byId.get(id)).find(g => g && g.label.includes("R107"));
const newR129 = (newFam.generations || []).map(id => cw.byId.get(id)).find(g => g && g.label.includes("R129"));
const newR230 = (newFam.generations || []).map(id => cw.byId.get(id)).find(g => g && g.label.includes("R230"));
const newR231 = (newFam.generations || []).map(id => cw.byId.get(id)).find(g => g && g.label.includes("R231"));
check("new R107 generation minted", !!newR107);
check("new R129 generation minted", !!newR129);
check("new R230 generation minted", !!newR230);
check("new R231 generation minted", !!newR231);

console.log("\n--- tier: combined-label duplicate (\"R107 and C107\") ---");
const combinedNode = cw.byId.get(COMBINED_ID);
check("the combined-label standalone was found as a duplicate and retired (not left behind)", combinedNode && combinedNode.retired === true);
check("it points at the new R107 generation as its replacement", combinedNode && newR107 && combinedNode.supersededBy === newR107.id);
check("its real harvested year (1971) was inherited (fresh proposal had no year for R107)", newR107 && newR107.year === 1971, newR107 && newR107.year);
check("its My Database flag was inherited", newR107 && newR107.db === true);
check("its designer credit was folded up to the family level", newFam.designers && newFam.designers.includes("Old Combined Designer"), newFam.designers);
const reboundRelated = cw.links.find(l => l.type === "related" && l.rebound && l.reboundFrom === COMBINED_ID &&
  ((lid(l.source) === (newR107 && newR107.id) && lid(l.target) === OTHER_ID) || (lid(l.target) === (newR107 && newR107.id) && lid(l.source) === OTHER_ID)));
check("its 'related' link to Test928 was rebound onto the new R107 generation", !!reboundRelated);
check("no duplicate designer person node was minted (same name reused)", cw.nodes.filter(n => n.type === "person" && n.label === "Old Combined Designer").length === 1);
check("combined-label duplicate is not eligible for a fresh LLM generation check anymore", !window.LlmFamilies.isEligible(combinedNode));

console.log("\n--- tier: duplicate already grouped under a DIFFERENT pre-existing family ---");
const oldR129Node = cw.byId.get(OLD_R129_ID), oldR230Node = cw.byId.get(OLD_R230_ID), oldR231Node = cw.byId.get(OLD_R231_ID);
check("old R129 (from the build-time family) was found as a duplicate and retired", oldR129Node && oldR129Node.retired === true);
check("old R230 was found as a duplicate and retired", oldR230Node && oldR230Node.retired === true);
check("old R231 was found as a duplicate and retired", oldR231Node && oldR231Node.retired === true);
check("old R129 points at the new R129 generation as its replacement", oldR129Node && newR129 && oldR129Node.supersededBy === newR129.id);
check("old R230 points at the new R230 generation as its replacement", oldR230Node && newR230 && oldR230Node.supersededBy === newR230.id);
check("old R231 points at the new R231 generation as its replacement", oldR231Node && newR231 && oldR231Node.supersededBy === newR231.id);
const reboundDesigned = cw.links.find(l => l.type === "designed" && l.rebound && l.reboundFrom === OLD_R230_ID &&
  lid(l.source) === (newR230 && newR230.id) && lid(l.target) === DESIGNER_ID);
check("the old family-grouped R230's designer link was rebound onto the new R230 generation", !!reboundDesigned);

console.log("\n--- cross-nameplate code collision safety (same make, unrelated nameplate, same bare code) ---");
const unrelatedGenNode = cw.byId.get(UNRELATED_GEN_ID);
const unrelatedFamNode = cw.byId.get(UNRELATED_FAM_ID);
check("the unrelated G-Class (R230) was NOT wrongly matched as a duplicate of SL-Class's own R230 -- still live, not retired",
  unrelatedGenNode && unrelatedGenNode.retired !== true, unrelatedGenNode && unrelatedGenNode.retired);
check("the unrelated G-Class family was NOT touched at all", unrelatedFamNode && unrelatedFamNode.retired !== true && !unrelatedFamNode.supersededBy);
check("it's still visible via nodeInLayer, completely unaffected", cw.nodeInLayer(unrelatedFamNode));

console.log("\n--- old family auto-retirement once ALL its generations are superseded ---");
const oldFamNode = cw.byId.get(OLD_FAM_ID);
check("the old family itself is now retired -- every one of its generations was superseded, it's an empty husk otherwise", oldFamNode && oldFamNode.retired === true);
check("it points at the new family as its replacement", oldFamNode && oldFamNode.supersededBy === newFam.id);
check("the old family is hidden from nodeInLayer", !cw.nodeInLayer(oldFamNode));
check("the old family's own generations are hidden from nodeInLayer too", !cw.nodeInLayer(oldR129Node) && !cw.nodeInLayer(oldR230Node) && !cw.nodeInLayer(oldR231Node));
check("the new family and its generations ARE visible", cw.nodeInLayer(newFam));
cw.expandFamily(newFam.id);
check("...including once expanded", cw.nodeInLayer(newR107) && cw.nodeInLayer(newR129) && cw.nodeInLayer(newR230) && cw.nodeInLayer(newR231));

console.log("\n--- integrity ---");
const broken = cw.links.filter(l => !l.retired && (!l.sn || !l.tn));
check("every non-retired link resolves to real sn/tn node objects", broken.length === 0, broken.length);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
