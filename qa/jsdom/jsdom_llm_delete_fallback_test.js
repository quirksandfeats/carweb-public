// Verifies task #54: when an LLM-confirmed nameplate later gets deleted via
// the debug panel, the designers/engineers it discovered shouldn't vanish --
// they should fall back to being credited directly on the plain model node
// instead. Two scenarios: (1) confirmNode() records allDesigners/
// allEngineers, and deleteEntry() turns that into a tombstone rather than a
// clean wipe; (2) a FRESH page load (fresh jsdom window, mimicking the
// location.reload() the debug panel triggers) that boots straight from a
// tombstone-only llm_families.json correctly wires the fallback links
// without ever minting generations.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
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
function freshWindow(llmFamiliesSeed) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("d3.min.js");
  loadScript("data.js");
  window.LLM_FAMILIES = llmFamiliesSeed || { families: {}, __serverAvailable: false };
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");
  return window;
}

const TEST_ID = "m-dacia-logan";

// ---------- scenario 1: confirm -> delete, same session ----------
// Seed a "provisional" entry (mirrors what a real checkNode() would have
// written) and drive it through the real confirmNode()/deleteEntry() flow,
// same pattern as jsdom_llm_confirm_test.js.
{
  const entry = {
    status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "Dacia Logan",
    proposal: {
      hasMultipleGenerations: true,
      generations: [
        { code: "Phase 1", yearStart: 2004, yearEnd: 2012, designers: ["Giorgetto Giugiaro"], engineers: [] },
        { code: "Phase 2", yearStart: 2012, yearEnd: 2020, designers: ["Balázs Filczer"], engineers: ["Balázs Filczer"] },
      ],
    },
    attempts: 1, feedback: [],
  };
  const window2 = freshWindow({ families: { [TEST_ID]: entry }, __serverAvailable: true });
  const cw2 = window2.CarWeb;
  cw2.boot();
  // Real user request: a first-time nameplate creation needs no manual
  // approval -- opening the detail panel auto-confirms and live-applies
  // this seeded "provisional" entry immediately.
  cw2.openDetail(cw2.byId.get(TEST_ID));

  const confirmedEntry = window2.LlmFamilies.entryFor(TEST_ID);
  check("confirmNode recorded allDesigners", confirmedEntry.status === "confirmed" &&
    confirmedEntry.allDesigners && confirmedEntry.allDesigners.includes("Giorgetto Giugiaro") &&
    confirmedEntry.allDesigners.includes("Balázs Filczer"), confirmedEntry.allDesigners);
  check("confirmNode recorded allEngineers", confirmedEntry.allEngineers && confirmedEntry.allEngineers.includes("Balázs Filczer"),
    confirmedEntry.allEngineers);

  const famNode = cw2.byId.get(TEST_ID);
  check("nameplate is now a family with generations (test precondition)", famNode.type === "family" && famNode.generations.length === 2);

  window2.LlmFamilies.deleteEntry(TEST_ID);
  const tombstone = window2.LlmFamilies.entryFor(TEST_ID);
  check("deleteEntry() converted the confirmed entry into a 'deleted' tombstone, not a clean wipe",
    !!tombstone && tombstone.status === "deleted");
  check("tombstone kept the discovered designers", tombstone.allDesigners.includes("Giorgetto Giugiaro") && tombstone.allDesigners.includes("Balázs Filczer"));
  check("tombstone kept the discovered engineers", tombstone.allEngineers.includes("Balázs Filczer"));
  check("tombstone dropped the heavy proposal/attempts/feedback fields", !tombstone.proposal && !tombstone.attempts && !tombstone.feedback);
}

// ---------- scenario 2: fresh page load straight from a tombstone-only llm_families.json ----------
// This is what actually happens after the debug panel's location.reload().
{
  const tombstoneSeed = {
    families: {
      [TEST_ID]: {
        status: "deleted", deletedAt: new Date().toISOString(), sourceTitle: "Dacia Logan",
        allDesigners: ["Giorgetto Giugiaro", "Balázs Filczer"], allEngineers: ["Balázs Filczer"],
      },
    },
    __serverAvailable: false,
  };
  const window = freshWindow(tombstoneSeed);
  const cw = window.CarWeb;
  cw.boot();

  const n = cw.byId.get(TEST_ID);
  check("model stayed a plain model (no generations minted from a tombstone)", n.type === "model" && !n.familyOf);
  check("model's own designers array picked up the fallback names",
    n.designers.includes("Giorgetto Giugiaro") && n.designers.includes("Balázs Filczer"), n.designers);
  check("model's own engineers array picked up the fallback name", n.engineers.includes("Balázs Filczer"), n.engineers);

  const giugiaro = [...cw.byId.values()].find(p => p.type === "person" && p.label === "Giorgetto Giugiaro");
  const filczer = [...cw.byId.values()].find(p => p.type === "person" && p.label === "Balázs Filczer");
  check("Giugiaro person node exists (reused, since he's already a real designer elsewhere)", !!giugiaro);
  check("Filczer person node was (re-)minted", !!filczer);

  // d3.forceLink (via buildSim() inside boot()) mutates link.source/target
  // from string ids into direct node object references once the sim
  // initializes -- compare via l.sn/l.tn (the pre-resolved refs app.js
  // itself sets), not l.source/l.target, same gotcha documented in
  // jsdom_llm_confirm_test.js.
  const designedLink = cw.links.find(l => l.type === "designed" && l.sn === n && l.tn === giugiaro);
  const engineeredLink = cw.links.find(l => l.type === "engineered" && l.sn === n && l.tn === filczer);
  check("direct designed-link from the PLAIN MODEL (not a family) to Giugiaro exists", !!designedLink);
  check("direct engineered-link from the PLAIN MODEL to Filczer exists", !!engineeredLink);
  check("no 'generation' hub links were created for this node (never became a family)",
    !cw.links.some(l => l.type === "generation" && l.sn === n));
  check("nodeInLayer shows the model normally (not hidden by any stale familyOf)", cw.nodeInLayer(n));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
