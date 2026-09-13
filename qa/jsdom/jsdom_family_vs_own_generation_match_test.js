// Real bug report: checking the Toyota Auris correctly found a mention of
// "Toyota Corolla (E140/E150)" as a related/platform car, but
// findMatchingNameplate's loose substring fallback matched BOTH the real,
// already-existing "Corolla (E140)" generation node AND its own parent
// family node "Corolla" (a family's bare label is always a substring of
// anything one of its generations matches), so loose.length was 2 instead
// of the required 1 -- and the whole thing fell through to mintRelatedNode,
// which created a brand-new duplicate "Toyota Corolla (E140/E150)" node
// with a null year and no link, instead of reusing the real, existing
// Corolla (E140) generation.
//
// findMatchingNameplate now drops a family from the loose-candidate set
// whenever one of ITS OWN generations is also independently a loose
// candidate for the same mention -- the generation is always the more
// specific, correct answer. This test mirrors the real Auris/Corolla shape
// exactly (single-generation nameplate being checked, an existing family
// with an existing generation whose label is a substring match, mention
// text shaped like "<FamilyLabel> (<ExistingCode>/<NewCode>)") and proves
// the mention resolves onto the existing generation node -- no duplicate
// node gets minted, no null-year ghost node appears in the graph.
//
// Test nameplate/codes ("Zorquine"/"VJ41"/"VJ42") were chosen and verified
// against the real, live app/data.js to have zero incidental loose-match
// collisions with any real production car (unlike an early draft of this
// test, which picked "Corollaish"/"E140/E150" and accidentally collided
// with real nodes like Porsche 912, Chevrolet 150, DiDia 150, and the
// heritage Toyota Corolla entry -- a good reminder that short numeric
// generation codes need checking against the real dataset before use here).
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

const NAMEPLATE_ID = "m-test-fvog-nameplate";
const FAM_ID = "fam-test-fvog-zorquine", GEN_ID = "m-test-fvog-zorquine-vj41";

const NAMEPLATE_WIKITEXT = "{{Infobox automobile\n| name = TestMake Vandrelish\n| production = 2006-2012\n}}\n" +
  "The TestMake Vandrelish is closely related to the TestMake Zorquine (VJ41/VJ42).";
let lastOllamaBody = null;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": NAMEPLATE_WIKITEXT } } }) });
  }
  if (u === "/api/llm/chat") {
    lastOllamaBody = JSON.parse(opts.body);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestMake Vandrelish", yearStart: 2006, yearEnd: 2012, designers: [], engineers: [],
          sharedPlatforms: ["TestMake Zorquine (VJ41/VJ42)"],
        }],
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
let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestFvogMake");
if (!mk) { mk = { id: "mk-test-fvog-make", type: "make", label: "TestFvogMake", year: 1950 }; DATA.nodes.push(mk); }

const nameplate = { id: NAMEPLATE_ID, type: "model", label: "Vandrelish", make: "TestFvogMake", wp: "TestMake Vandrelish", year: 2006, end: 2012 };
// The real, ALREADY-EXISTING family + generation this mention should
// resolve onto -- mirrors fam-toyota-corolla / m-toyota-corolla-e140 in the
// real production dataset exactly (family label is a bare substring of its
// own generation's label).
const fam = { id: FAM_ID, type: "family", label: "Zorquine", make: "TestFvogMake", year: 1966, end: null,
  designers: [], engineers: [], generations: [GEN_ID] };
const gen = { id: GEN_ID, type: "model", label: "Zorquine (VJ41)", make: "TestFvogMake", year: 2006, end: 2013, familyOf: FAM_ID };
DATA.nodes.push(nameplate, fam, gen);
DATA.links.push(
  { source: NAMEPLATE_ID, target: mk.id, type: "made" },
  { source: FAM_ID, target: mk.id, type: "made" },
  { source: FAM_ID, target: GEN_ID, type: "generation" },
);

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
cw.setLlmCheck(true);

// Precondition: the mention text really is a loose-match ambiguity between
// the family and its own generation (i.e. this test is actually exercising
// the bug, not something else) -- and that it does NOT collide with any
// unrelated real production node.
{
  const key = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const mention = key("TestMake Zorquine (VJ41/VJ42)");
  check("precondition: mention loosely matches the family's bare label", mention.includes(key("Zorquine")));
  check("precondition: mention loosely matches the existing generation's label", mention.includes(key("Zorquine (VJ41)")));
  const collisions = cw.nodes.filter(n => (n.type === "model" || n.type === "family") &&
    n.id !== FAM_ID && n.id !== GEN_ID && key(n.label || "").length > 2 &&
    (mention.includes(key(n.label)) || key(n.label).includes(mention)));
  check("precondition: no incidental collision with unrelated real production nodes", collisions.length === 0, collisions.map(n => n.id));
}

cw.openDetail(nameplate);

(async () => {
  await sleep(60);
  const msgText = lastOllamaBody ? JSON.stringify(lastOllamaBody.messages) : "";
  check("check actually ran against the mock", !!msgText);

  const entry = window.LlmFamilies.entryFor(NAMEPLATE_ID);
  check("check completed", !!entry, entry);

  // findMatchingNameplate matched the mention onto the existing GENERATION
  // node, but a loose (substring, not exact) match never auto-applies --
  // same trust tier every other loose match gets (see the Toyota C-HR bug
  // this function's own comment describes). It's recorded as a family<->
  // family-ish "platform" relation entry (famB = the generation's PARENT
  // family, since that's what a relation entry's famA/famB always key off
  // of) with genIdB pointing at the exact real generation node -- not a
  // brand-new one -- ready for a normal Yes/No confirm. The STORAGE key
  // itself (task #106, multi-generation-pair support) is scoped to the two
  // SPECIFIC generation ids actually involved (NAMEPLATE_ID's own single
  // generation and the real GEN_ID it resolved to), not the coarser whole-
  // family id, so a different generation independently mentioning its own
  // platform partner would get its own entry instead of colliding here.
  const key = [NAMEPLATE_ID, GEN_ID].sort().join("|") + "|platform";
  const rel = window.LlmFamilies.relationEntryFor(key);
  // What this test is FOR is the duplicate: the mention must resolve onto the
  // existing generation node rather than minting a ghost beside it. That is
  // unchanged.
  //
  // What the mention then BECOMES has changed, per the user: "for a string
  // that only matches a substring, that's correct that it's too much of a
  // stretch and to not try to do a match." It used to be filed as a
  // provisional relation for review; now it is not filed at all, and is
  // recorded so it is not proposed again. Resolving onto the right node still
  // matters either way -- it is what stops the ghost being minted.
  check("a substring match no longer becomes a relation awaiting review",
        !rel || rel.status !== "provisional", rel);
  check("...and leaves nothing behind for a human to decide",
        !rel, JSON.stringify(rel));

  const ghost = cw.nodes.find(n => /zorquine/i.test(n.label || "") && n.id !== GEN_ID && n.id !== FAM_ID);
  check("no duplicate/ghost 'Zorquine (VJ41/VJ42)' node was minted", !ghost, ghost);

  const genFresh = cw.byId.get(GEN_ID);
  check("existing generation node's year was left untouched (not nulled out by a mint)", genFresh && genFresh.year === 2006, genFresh);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
