// Real user request (task #106): "The Mazda Familiqua is determined to be a
// nameplate. Once the llm looks through the Familiqua's nameplate, it notices
// that the Ford escort is a Related platform... what it needs to consider is
// that, lets say, the third generation of the Familiqua corresponds to the
// second generation of the Qelvorash, and the fourth generation of the Familiqua
// corresponds to the third generation of the escort. There must also be a
// check that determines which generation of one nameplate corresponds to
// which generation of another nameplate, and that there may be multiple
// edges going between the two nameplates, where the pairs of nodes connected
// may all be different."
//
// Before this fix, resolveOnePlatformMention keyed every discovered relation
// by the two NAMEPLATES alone (relKey(famId, matchId, relType)) -- so the
// FIRST generation's mention (Familiqua Gen3 -> Qelvorash Gen2) would silently
// block the SECOND generation's mention (Familiqua Gen4 -> Qelvorash Gen3) from
// ever being stored at all, since both computed the exact same key. This
// test mints a fresh Familiqua-like nameplate with two generations, each
// naming a DIFFERENT specific Qelvorash generation via an explicit code, and
// proves BOTH resolve into their own independently-confirmed entries and
// real generation<->generation graph links -- neither one clobbers the
// other.
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

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

const FAMILIA_ID = "m-test-mg-familia";
const ESCORT_ID = "fam-test-mg-escort", ESCORT_G2_ID = "m-test-mg-escort-g2", ESCORT_G3_ID = "m-test-mg-escort-g3";

// Familiqua's own article: a plain, not-yet-split nameplate whose Wikitext
// (stubbed below via the LLM response, not really parsed here) will turn
// out to hide two real generations -- one explicitly naming Qelvorash's 2nd
// generation as its platform donor, the other explicitly naming Qelvorash's
// 3rd. extractExplicitGenCode looks for "<make> <label> (<code>)" right in
// the mention text itself, so the mention strings below are shaped exactly
// like that against the real Qelvorash family node created below.
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    // The hallucination guard (validate()) requires every claimed code and
    // sharedPlatforms mention to appear VERBATIM in the real fetched
    // wikitext -- so this has to actually contain "Gen3fam"/"Gen4fam" and
    // both "TestFordMg Qelvorash (ZG2xq)"/"(ZG3xq)" mentions, not just describe
    // them abstractly.
    const wt = "{{Infobox automobile|name=TestMazdaMg Familiqua}}\n" +
      "== Gen3fam (1980-1985) ==\nThe Gen3fam shared its platform with the TestFordMg Qelvorash (ZG2xq).\n" +
      "== Gen4fam (1985-1989) ==\nThe Gen4fam shared its platform with the TestFordMg Qelvorash (ZG3xq).\n";
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: true,
        generations: [
          { code: "Gen3fam", yearStart: 1980, yearEnd: 1985, designers: [], engineers: [],
            sharedPlatforms: ["TestFordMg Qelvorash (ZG2xq)"] },
          { code: "Gen4fam", yearStart: 1985, yearEnd: 1989, designers: [], engineers: [],
            sharedPlatforms: ["TestFordMg Qelvorash (ZG3xq)"] },
        ],
      }) } }] }),
    });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let mazdaMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestMazdaMg");
if (!mazdaMake) { mazdaMake = { id: "mk-test-mg-mazda", type: "make", label: "TestMazdaMg", year: 1950 }; DATA.nodes.push(mazdaMake); }
let fordMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestFordMg");
if (!fordMake) { fordMake = { id: "mk-test-mg-ford", type: "make", label: "TestFordMg", year: 1950 }; DATA.nodes.push(fordMake); }

const familia = { id: FAMILIA_ID, type: "model", label: "Familiqua", make: "TestMazdaMg", wp: "TestMazdaMg Familiqua", year: 1980, end: 1989 };
const escort = { id: ESCORT_ID, type: "family", label: "Qelvorash", make: "TestFordMg", year: 1975, end: null, designers: [], engineers: [], generations: [ESCORT_G2_ID, ESCORT_G3_ID] };
const escortG2 = { id: ESCORT_G2_ID, type: "model", label: "ZG2xq", make: "TestFordMg", year: 1975, end: 1980, familyOf: ESCORT_ID };
const escortG3 = { id: ESCORT_G3_ID, type: "model", label: "ZG3xq", make: "TestFordMg", year: 1980, end: 1990, familyOf: ESCORT_ID };
DATA.nodes.push(familia, escort, escortG2, escortG3);
DATA.links.push(
  { source: FAMILIA_ID, target: mazdaMake.id, type: "made" },
  { source: ESCORT_ID, target: fordMake.id, type: "made" },
  { source: ESCORT_ID, target: ESCORT_G2_ID, type: "generation" },
  { source: ESCORT_ID, target: ESCORT_G3_ID, type: "generation" },
  { source: ESCORT_G2_ID, target: ESCORT_G3_ID, type: "gensucc" },
);

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
cw.setLlmCheck(true);
cw.openDetail(familia);

(async () => {
  await sleep(80);

  // The Familiqua nameplate creation auto-applies (see renderLlmCheck's
  // "provisional" branch) -- it should now be a real family with 2
  // generations of its own.
  const familiaFam = cw.byId.get(FAMILIA_ID);
  check("Familiqua was recognized as a real nameplate with 2 generations", familiaFam && familiaFam.type === "family" && familiaFam.generations && familiaFam.generations.length === 2,
    familiaFam && { type: familiaFam.type, generations: familiaFam.generations });
  const gen3 = familiaFam && cw.byId.get(familiaFam.generations[0]);
  const gen4 = familiaFam && cw.byId.get(familiaFam.generations[1]);
  check("generation 3 (older) is Gen3fam", gen3 && gen3.label.includes("Gen3fam"), gen3 && gen3.label);
  check("generation 4 (newer) is Gen4fam", gen4 && gen4.label.includes("Gen4fam"), gen4 && gen4.label);

  // ---------- the actual multi-pair fix: BOTH mentions must resolve, independently ----------
  // Each mention loosely matches its OWN specific Qelvorash generation
  // directly (its code is a substring of the mention), so this lands in
  // resolveOnePlatformMention's "already as specific as it can get" branch
  // -- a loose match there always requires review ("provisional"), same
  // trust tier as any other loose match gets. The point being proven here
  // isn't the confirm-tier -- it's that BOTH distinct pairs get their own
  // entry at all, instead of the second one colliding with the first.
  const key1 = [gen3.id, ESCORT_G2_ID].sort().join("|") + "|platform";
  const key2 = [gen4.id, ESCORT_G3_ID].sort().join("|") + "|platform";
  const rel1 = window.LlmFamilies.relationEntryFor(key1);
  const rel2 = window.LlmFamilies.relationEntryFor(key2);
  check("Familiqua Gen3 <-> Qelvorash G2 resolved into its own entry", !!rel1 && rel1.status === "provisional", rel1);
  check("Familiqua Gen4 <-> Qelvorash G3 ALSO resolved into its own entry -- NOT dropped by the first pair's entry", !!rel2 && rel2.status === "provisional", rel2);
  check("the two entries point at genuinely DIFFERENT generation pairs, not the same one twice",
    rel1 && rel2 && (rel1.genIdA !== rel2.genIdA) && (rel1.genIdB !== rel2.genIdB),
    rel1 && rel2 && { pair1: [rel1.genIdA, rel1.genIdB], pair2: [rel2.genIdA, rel2.genIdB] });

  // ---------- the UI must render BOTH as separate, independently confirmable boxes ----------
  // Reopen the detail panel (real UI path) so unresolvedFamilyRelations
  // picks up BOTH provisional entries via relationsTouching -- this is the
  // app.js half of the fix: each entry's own specific key (not a shared
  // coarse nameplate-level one) is what lets both boxes render and be
  // acted on independently instead of the second colliding with the first.
  cw.openDetail(familiaFam);
  const yesBtns = [...window.document.querySelectorAll(".dt-relations .llm-rel-yes")];
  check("BOTH pairs get their own independent Yes/No box -- not merged or dropped to just one", yesBtns.length === 2, yesBtns.length);

  // Click both -- same as two separate real user confirmations.
  yesBtns.forEach(b => b.onclick());

  const rel1After = window.LlmFamilies.relationEntryFor(key1);
  const rel2After = window.LlmFamilies.relationEntryFor(key2);
  check("Gen3<->G2 confirmed", rel1After && rel1After.status === "confirmed", rel1After);
  check("Gen4<->G3 confirmed", rel2After && rel2After.status === "confirmed", rel2After);

  // ---------- both real graph links must exist, distinctly ----------
  const link1 = cw.links.find(l => l.type === "platform" && l.llmResolved &&
    ((l.sn === gen3 && l.tn === escortG2) || (l.sn === escortG2 && l.tn === gen3)));
  const link2 = cw.links.find(l => l.type === "platform" && l.llmResolved &&
    ((l.sn === gen4 && l.tn === escortG3) || (l.sn === escortG3 && l.tn === gen4)));
  check("real Gen3fam <-> ZG2xq link exists", !!link1);
  check("real Gen4fam <-> ZG3xq link exists", !!link2);
  check("they are two SEPARATE link objects, not the same edge reused", link1 !== link2);

  // ---------- both links are independently drawable once both nameplates are expanded ----------
  cw.expandFamily(FAMILIA_ID);
  cw.expandFamily(ESCORT_ID);
  check("Gen3<->G2 link is drawable", !!link1 && cw.linkInLayer(link1) && cw.nodeInLayer(link1.sn) && cw.nodeInLayer(link1.tn));
  check("Gen4<->G3 link is drawable", !!link2 && cw.linkInLayer(link2) && cw.nodeInLayer(link2.sn) && cw.nodeInLayer(link2.tn));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
