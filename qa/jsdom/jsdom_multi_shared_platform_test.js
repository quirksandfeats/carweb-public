// Real user report (Scion xB / Toyota bB case): checking a nameplate whose
// article names SEVERAL related/rebadged cars for one generation (not just
// one) used to only ever capture a single sharedPlatform string -- "make
// sure that the LLM is formatted so that it can capture every related car
// that is listed, whether it's in the info box or in the paragraphs
// explicitly mentioned." Verifies the schema is now an ARRAY
// (sharedPlatforms) and that llm_families.js resolves EVERY entry in it
// into its own platform link, not just the first.
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

const XB_ID = "m-test-multisp-xb";
const RUMION_ID = "m-test-multisp-rumion", RUKUS_ID = "m-test-multisp-rukus", BB_ID = "m-test-multisp-bb";

const XB_WIKITEXT = "{{Infobox automobile\n| name = TestScion xBish\n| production = 2003-2006\n}}\n" +
  "The TestScion xBish shares its platform with the TestToyota bBish. It was also sold in other markets as the " +
  "TestToyota Corolla Rumionish and the TestToyota Rukusish.";
let lastOllamaBody = null;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": XB_WIKITEXT } } }) });
  }
  if (u === "/api/llm/chat") {
    const parsed = JSON.parse(opts.body);
    // Only remember the GENERATION-EXTRACTION call, not every chat call.
    // Several other kinds now land on this same endpoint during one check --
    // the duplicate sanity pass (annotateSharedPlatformMatches) and, as of
    // the Toyota Crown fix, a follow-on generation check scheduled for each
    // matched partner car (llm_families.js's schedulePartnerCheck). A plain
    // "last body wins" capture picks up whichever of those happens to finish
    // last, which has nothing to do with the assertion below.
    if (String(parsed.messages[0].content).includes("You extract car production-generation data")) {
      lastOllamaBody = parsed;
    }
    // A single-generation nameplate (hasMultipleGenerations:false) whose one
    // implicit generation entry names THREE related cars at once -- exactly
    // the shape the exhaustiveness fix targets.
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestScion xBish", yearStart: 2003, yearEnd: 2006, designers: [], engineers: [],
          sharedPlatforms: ["TestToyota bBish", "TestToyota Corolla Rumionish", "TestToyota Rukusish"],
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
if (!scionMake) { scionMake = { id: "mk-test-multisp-scion", type: "make", label: "TestScion", year: 1950 }; DATA.nodes.push(scionMake); }
let toyotaMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestToyota");
if (!toyotaMake) { toyotaMake = { id: "mk-test-multisp-toyota", type: "make", label: "TestToyota", year: 1950 }; DATA.nodes.push(toyotaMake); }

const xb = { id: XB_ID, type: "model", label: "xBish", make: "TestScion", wp: "TestScion xBish", year: 2003, end: 2006 };
// All three related cars already exist in the graph as plain models (the
// case resolvePlatformMention's "already as specific as it can get" branch
// handles) -- exact-name matches, so each should auto-confirm with zero
// clicks, same trust tier a single sharedPlatform match already got.
const rumion = { id: RUMION_ID, type: "model", label: "Corolla Rumionish", make: "TestToyota", year: 2007, end: null };
const rukus = { id: RUKUS_ID, type: "model", label: "Rukusish", make: "TestToyota", year: 2007, end: null };
const bb = { id: BB_ID, type: "model", label: "bBish", make: "TestToyota", year: 2000, end: 2005 };
DATA.nodes.push(xb, rumion, rukus, bb);
DATA.links.push(
  { source: XB_ID, target: scionMake.id, type: "made" },
  { source: RUMION_ID, target: toyotaMake.id, type: "made" },
  { source: RUKUS_ID, target: toyotaMake.id, type: "made" },
  { source: BB_ID, target: toyotaMake.id, type: "made" },
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

cw.openDetail(xb);

(async () => {
  await sleep(60);
  const msgText = lastOllamaBody ? JSON.stringify(lastOllamaBody.messages) : "";
  check("prompt asked for an exhaustive sharedPlatforms list, not a single value", msgText.includes("sharedPlatforms"), msgText.slice(0, 200));

  const entry = window.LlmFamilies.entryFor(XB_ID);
  check("check completed", !!entry, entry);
  check("validated proposal kept the array form", Array.isArray(entry.proposal.generations[0].sharedPlatforms), entry.proposal);
  check("ALL THREE related cars survived the hallucination guard, not just one",
    entry.proposal.generations[0].sharedPlatforms.length === 3, entry.proposal.generations[0].sharedPlatforms);

  // "none" status (single generation, no split) still live-applies its
  // sharedPlatforms via applySharedPlatformForSingleGen -- same path the
  // Infiniti QX30 single-sharedPlatform case already used.
  const keyBb = [XB_ID, BB_ID].sort().join("|") + "|platform";
  const keyRumion = [XB_ID, RUMION_ID].sort().join("|") + "|platform";
  const keyRukus = [XB_ID, RUKUS_ID].sort().join("|") + "|platform";
  const relBb = window.LlmFamilies.relationEntryFor(keyBb);
  const relRumion = window.LlmFamilies.relationEntryFor(keyRumion);
  const relRukus = window.LlmFamilies.relationEntryFor(keyRukus);
  check("bBish relation resolved (1 of 3)", !!relBb && relBb.status === "confirmed", relBb);
  check("Corolla Rumionish relation resolved (2 of 3) -- NOT dropped in favor of just the first match", !!relRumion && relRumion.status === "confirmed", relRumion);
  check("Rukusish relation resolved (3 of 3) -- NOT dropped either", !!relRukus && relRukus.status === "confirmed", relRukus);

  const linkBb = cw.links.find(l => l.type === "platform" &&
    ((l.sn === xb && l.tn === bb) || (l.sn === bb && l.tn === xb)));
  const linkRumion = cw.links.find(l => l.type === "platform" &&
    ((l.sn === xb && l.tn === rumion) || (l.sn === rumion && l.tn === xb)));
  const linkRukus = cw.links.find(l => l.type === "platform" &&
    ((l.sn === xb && l.tn === rukus) || (l.sn === rukus && l.tn === xb)));
  check("real graph link to bBish exists", !!linkBb);
  check("real graph link to Corolla Rumionish exists", !!linkRumion);
  check("real graph link to Rukusish exists", !!linkRukus);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
