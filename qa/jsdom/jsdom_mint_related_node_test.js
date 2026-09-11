// Real user request (task #53): "If the program looks through the wikipedia
// page of a specific nameplate I clicked on, then it should also populate
// new cars into the knowledge graph if it is mentioned as 'related', and
// should then populate that model/nameplate as well (if the model/nameplate
// does not yet exist, or if the relationship does not yet exist)." Before
// this, resolveOnePlatformMention just gave up silently
// (findMatchingNameplate returning null) whenever a shared-platform mention
// named a car that wasn't already ANYWHERE in the graph, even loosely --
// correct when there's nothing to anchor a guess to, but it meant a real
// related car could never surface just because this dataset didn't happen
// to include it yet. Verifies TWO cases: (1) a related car whose MAKE
// doesn't exist either (mints both a make node and a model node), and (2) a
// related car whose make already exists (mints just the model, reusing the
// existing make via findExistingMake's prefix match) -- plus that both new
// nodes are fully wired into the live graph (byId/adj/deg/r), not just
// pushed into the raw arrays.
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

const XB_ID = "m-test-mint-xb";

// Article mentions three related cars: one that already exists (control),
// one whose make AND model are both brand-new to the graph, and one whose
// make already exists but model doesn't.
const XB_WIKITEXT = "{{Infobox automobile\n| name = TestScion mintXbish\n| production = 2003-2006\n}}\n" +
  "The TestScion mintXbish shares its platform with the TestToyota mintBbish. It was also sold in other markets as the " +
  "TestWombat Zorbish and the TestToyota mintNewModelish.";
let lastOllamaBody = null;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": XB_WIKITEXT } } }) });
  }
  if (u === "/api/llm/chat") {
    lastOllamaBody = JSON.parse(opts.body);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestScion mintXbish", yearStart: 2003, yearEnd: 2006, designers: [], engineers: [],
          sharedPlatforms: ["TestToyota mintBbish", "TestWombat Zorbish", "TestToyota mintNewModelish"],
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
let scionMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestScion");
if (!scionMake) { scionMake = { id: "mk-test-mint-scion", type: "make", label: "TestScion", year: 1950 }; DATA.nodes.push(scionMake); }
let toyotaMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestToyota");
if (!toyotaMake) { toyotaMake = { id: "mk-test-mint-toyota", type: "make", label: "TestToyota", year: 1950 }; DATA.nodes.push(toyotaMake); }
// TestWombat make deliberately does NOT exist anywhere in the graph.
// TestToyota mintNewModelish also does not exist as a model, but its make does.

const xb = { id: XB_ID, type: "model", label: "mintXbish", make: "TestScion", wp: "TestScion mintXbish", year: 2003, end: 2006 };
const bb = { id: "m-test-mint-bb", type: "model", label: "mintBbish", make: "TestToyota", year: 2000, end: 2005 };
DATA.nodes.push(xb, bb);
DATA.links.push(
  { source: XB_ID, target: scionMake.id, type: "made" },
  { source: bb.id, target: toyotaMake.id, type: "made" },
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

const nodesBeforeCount = cw.nodes.length;
const linksBeforeCount = cw.links.length;

cw.openDetail(xb);

(async () => {
  await sleep(60);

  // Control: the already-existing bBish relation should still resolve normally.
  const keyBb = [XB_ID, bb.id].sort().join("|") + "|platform";
  const relBb = window.LlmFamilies.relationEntryFor(keyBb);
  check("control: already-existing related car still resolves", !!relBb && relBb.status === "confirmed", relBb);

  // Case 1: brand-new make AND model.
  const wombatMake = cw.nodes.find(n => n.type === "make" && n.label === "TestWombat");
  check("new make node minted for TestWombat", !!wombatMake, wombatMake);
  const zorb = cw.nodes.find(n => n.type === "model" && n.make === "TestWombat" && /Zorbish/.test(n.label));
  check("new model node minted for Zorbish", !!zorb, zorb);
  check("minted model tagged llmGenerated/llmCreatedNode for traceability", !!zorb && zorb.llmGenerated && zorb.llmCreatedNode, zorb);

  // Case 2: make already existed, only the model is new.
  const newModel = cw.nodes.find(n => n.type === "model" && n.make === "TestToyota" && /mintNewModelish/.test(n.label));
  check("new model minted under EXISTING TestToyota make (no duplicate make created)", !!newModel, newModel);
  const toyotaMakes = cw.nodes.filter(n => n.type === "make" && n.label === "TestToyota");
  check("still exactly one TestToyota make node (existing one reused, not duplicated)", toyotaMakes.length === 1, toyotaMakes.length);

  // Graph wiring: made-links from make to each minted model.
  const madeZorb = zorb && cw.links.find(l => l.type === "made" &&
    ((l.sn === wombatMake && l.tn === zorb) || (l.sn === zorb && l.tn === wombatMake)));
  check("made-link wired between TestWombat and Zorbish", !!madeZorb, madeZorb);
  const madeNewModel = newModel && cw.links.find(l => l.type === "made" &&
    ((l.sn === toyotaMake && l.tn === newModel) || (l.sn === newModel && l.tn === toyotaMake)));
  check("made-link wired between existing TestToyota make and new model", !!madeNewModel, madeNewModel);

  // Graph wiring: platform-links from xb to each minted model.
  const platZorb = zorb && cw.links.find(l => l.type === "platform" &&
    ((l.sn === xb && l.tn === zorb) || (l.sn === zorb && l.tn === xb)));
  check("platform-link wired between mintXbish and Zorbish", !!platZorb, platZorb);
  const platNewModel = newModel && cw.links.find(l => l.type === "platform" &&
    ((l.sn === xb && l.tn === newModel) || (l.sn === newModel && l.tn === xb)));
  check("platform-link wired between mintXbish and new TestToyota model", !!platNewModel, platNewModel);

  // Bookkeeping: byId/adj/deg/r must all be set for every minted node, not
  // just pushed into the raw nodes array -- this is exactly the prerequisite
  // fix applySharedPlatformLive needed (nodesBefore tracking) before minting
  // could be done safely.
  [wombatMake, zorb, toyotaMake, newModel].forEach(n => {
    if (!n) return;
    check(`byId has ${n.id}`, cw.byId.get(n.id) === n);
    check(`adj has an entry for ${n.id}`, Array.isArray(cw.adj.get(n.id)));
    check(`${n.id} has a numeric degree`, typeof n.deg === "number" && n.deg > 0, n.deg);
    check(`${n.id} has a numeric radius`, typeof n.r === "number" && n.r > 0, n.r);
  });

  check("nodes array actually grew", cw.nodes.length > nodesBeforeCount, cw.nodes.length - nodesBeforeCount);
  check("links array actually grew", cw.links.length > linksBeforeCount, cw.links.length - linksBeforeCount);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
