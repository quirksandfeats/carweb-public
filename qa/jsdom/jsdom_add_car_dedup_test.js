// Real user request: "Make sure that the local LLM also checks for whether
// the current model being analyzed, which might turn into a nameplate,
// might already have a model existing somewhere else that is listed as a
// model but is actually a generation of a specific nameplate. If this is
// the case, then transfer the contents of that model... into the current
// list of generations for the nameplate that is being analyzed. This should
// also apply to if the user is adding a new model for the first time by
// hand."
//
// The de-duplication/transfer mechanism itself (findDuplicateGeneration +
// supersedeStandalone in llm_families.js) already existed before this
// request, built for the automatic discovery flow (the Mercedes-Benz
// SL-Class R107 case -- see jsdom_family_dedup_test.js). What this test
// proves is the second half of the request: a car added by hand through the
// "Add Car" panel goes through the exact same checkNode -> confirmNode ->
// applyConfirmed pipeline as any other newly-opened plain model (mintAndOpen
// arms LLM Check and opens the detail panel exactly like browsing to an
// ordinary car), so when the LLM determines the hand-added car has multiple
// generations and one of them ("E2") turns out to already exist elsewhere in
// the graph as its own independent standalone model, that standalone's
// designer credit, My Database match, and related-car link all transfer
// onto the newly-minted generation, and the standalone itself is retired
// (never deleted) rather than left behind as a visible duplicate.
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

const MAKE_LABEL = "TestAddDedup";
const MODEL_LABEL = "Kelvorash";
const REAL_TITLE = "TestAddDedup Kelvorash";
const STANDALONE_ID = "m-test-adddedup-standalone-e2";
const OTHER_ID = "m-test-adddedup-other";
const PERSON_ID = "p-test-adddedup-old-designer";

const WIKITEXT = "{{Infobox automobile|name=TestAddDedup Kelvorash}}\n" +
  "== First generation E1 (2001-2008) ==\nThe first generation launched in 2001.\n" +
  "== Second generation E2 (2008-2015) ==\nThe second generation launched in 2008, styled by Fresh Read Designer.\n";

window.fetch = (url, opts) => {
  const u = String(url);
  if (u.includes("action=parse")) {
    const m = u.match(/page=([^&]+)/);
    const title = decodeURIComponent(m[1]);
    if (title === REAL_TITLE) return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  if (u.includes("action=query") && u.includes("list=search")) return Promise.resolve({ ok: true, json: async () => ({ query: { search: [] } }) });
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    const promptStr = JSON.stringify(body.messages);
    const isDupCheck = body.messages[0].content.startsWith("You check whether a mentioned car");
    if (isDupCheck) return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ matchId: null, confidence: "low", reason: "n/a" }) } }] }) });
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      hasMultipleGenerations: true,
      generations: [
        { code: "E1", yearStart: 2001, yearEnd: 2008, designers: [], engineers: [] },
        { code: "E2", yearStart: 2008, yearEnd: 2015, designers: ["Fresh Read Designer"], engineers: [] },
      ],
    }) } }] }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

// Seed the pre-existing standalone "E2" generation elsewhere in the graph --
// never grouped into any family, carrying real accumulated data of its own:
// a designer credit, a My Database match, and a related-car link.
const DATA = window.CARDATA;
let mk = DATA.nodes.find(n => n.id === "mk-test-adddedup");
if (!mk) { mk = { id: "mk-test-adddedup", type: "make", label: MAKE_LABEL, year: 1990 }; DATA.nodes.push(mk); }
const standalone = {
  id: STANDALONE_ID, type: "model", label: "E2", make: MAKE_LABEL, year: 2008, end: 2015,
  wp: "TestAddDedup E2 Standalone", designers: ["Old Standalone Designer"], engineers: [],
  db: true, dbspecs: { modelYear: "2010" }, dbphoto: "db_photos/test-adddedup-e2.jpg",
};
const other = { id: OTHER_ID, type: "model", label: "TestOtherCar", make: MAKE_LABEL, year: 2009, end: 2016 };
const person = { id: PERSON_ID, type: "person", kind: "person", label: "Old Standalone Designer", roles: ["designer"], born: null, died: null, country: null, wp: null };
DATA.nodes.push(standalone, other, person);
DATA.links.push(
  { source: mk.id, target: standalone.id, type: "made" },
  { source: mk.id, target: other.id, type: "made" },
  { source: standalone.id, target: other.id, type: "related", note: "test-adddedup-related" },
  { source: standalone.id, target: person.id, type: "designed" },
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

const btn = window.document.getElementById("addcarbtn");
btn.onclick();
window.document.getElementById("addcar-make").value = MAKE_LABEL;
window.document.getElementById("addcar-model").value = MODEL_LABEL;
window.document.getElementById("addcar-submit").onclick();

setTimeout(() => {
  const famId = "usercar-testadddedup-kelvorash";
  const fam = cw.byId.get(famId);
  check("the hand-added car was recognized as a real nameplate with 2 generations",
    !!fam && fam.type === "family" && Array.isArray(fam.generations) && fam.generations.length === 2,
    fam && { type: fam.type, generations: fam.generations });

  const gen2Id = fam && fam.generations[1];
  const gen2 = gen2Id && cw.byId.get(gen2Id);
  check("the newly-minted 'E2' generation exists", !!gen2 && /E2/.test(gen2.label), gen2 && gen2.label);

  const oldStandalone = cw.byId.get(STANDALONE_ID);
  check("the pre-existing standalone 'E2' model is now retired (never deleted, just hidden)",
    oldStandalone && oldStandalone.retired === true, oldStandalone);
  check("the retired standalone records where it went (supersededBy the new generation)",
    oldStandalone && oldStandalone.supersededBy === gen2Id, oldStandalone && oldStandalone.supersededBy);

  check("the standalone's OWN designer credit transferred onto the new generation",
    gen2 && Array.isArray(gen2.designers) && gen2.designers.includes("Old Standalone Designer"), gen2 && gen2.designers);
  check("the LLM's OWN freshly-found designer credit is also still there (nothing overwritten, just merged)",
    gen2 && gen2.designers.includes("Fresh Read Designer"), gen2 && gen2.designers);

  check("the standalone's My Database match (gold ring data) transferred onto the new generation",
    gen2 && gen2.db === true && gen2.dbphoto === "db_photos/test-adddedup-e2.jpg", gen2 && { db: gen2.db, dbphoto: gen2.dbphoto });

  const reboundRelated = cw.links.find(l => l.type === "related" && l.reboundFrom === STANDALONE_ID &&
    ((l.sn === gen2 && l.tn === other) || (l.sn === other && l.tn === gen2)));
  check("the standalone's related-car link was rebound onto the new generation (not silently lost)",
    !!reboundRelated, reboundRelated);

  const reboundDesignedLink = cw.links.find(l => l.type === "designed" && l.reboundFrom === STANDALONE_ID &&
    ((l.sn === gen2 && l.tn === person) || (l.sn === person && l.tn === gen2)));
  check("the standalone's direct 'designed by' link to the person node was also rebound",
    !!reboundDesignedLink, reboundDesignedLink);

  const ghost = cw.nodes.find(n => n.id !== STANDALONE_ID && n.id !== gen2Id && n.label === "E2");
  check("no THIRD duplicate 'E2' node was minted alongside the retired standalone and the real generation",
    !ghost, ghost);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}, 100);
