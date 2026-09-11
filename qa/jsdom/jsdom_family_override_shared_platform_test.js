// Real gap found while adding multi-relation support (task #50): the
// nameplate generation-list OVERRIDE flow (applyFamilyOverride -- accepting
// a "this existing nameplate's generation list is wrong, here's what
// Wikipedia actually says" correction) called resolvePlatformMention() on
// every minted/reused generation, but never actually SET
// gn.sharedPlatformTexts/sharedPlatformText on it first -- so a shared-
// platform/rebadge mention discovered by THIS flow specifically never once
// resolved into a real relation, even though the same mention discovered by
// the two OTHER flows (first-time nameplate creation, and the single-
// generation "none" verdict) already did. Verifies accepting a generation-
// list override now also wires in a real platform link.
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

const FAM_ID = "fam-test-fovsp-x3", BARE_ID = "m-test-fovsp-x3-bare", G01_ID = "m-test-fovsp-x3-g01";
const X4_ID = "m-test-fovsp-x4";

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
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestBMWfovsp");
if (!makeNode) { makeNode = { id: "mk-test-fovsp", type: "make", label: "TestBMWfovsp", year: 1916 }; DATA.nodes.push(makeNode); }
const famX3 = { id: FAM_ID, type: "family", label: "X3fovsp", make: "TestBMWfovsp", year: 2003, end: null,
  designers: [], engineers: [], generations: [BARE_ID, G01_ID] };
const bareGen = { id: BARE_ID, type: "model", label: "X3fovsp", make: "TestBMWfovsp", year: 2003, end: 2010,
  familyOf: FAM_ID, wp: "TestBMWfovsp X3fovsp", designers: [], engineers: [] };
const g01Gen = { id: G01_ID, type: "model", label: "X3fovsp (G01)", make: "TestBMWfovsp", year: 2017, end: null,
  familyOf: FAM_ID, wp: "TestBMWfovsp X3fovsp (G01)", designers: [], engineers: [] };
const x4 = { id: X4_ID, type: "model", label: "X4fovsp", make: "TestBMWfovsp", year: 2014, end: null };
DATA.nodes.push(famX3, bareGen, g01Gen, x4);
DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" }, { source: X4_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: FAM_ID, target: BARE_ID, type: "generation" }, { source: FAM_ID, target: G01_ID, type: "generation" });
DATA.links.push({ source: BARE_ID, target: G01_ID, type: "gensucc" });

// A pre-decided override proposal (same shortcut jsdom_family_recheck_test.js
// uses) -- G01's fresh reading now ALSO names a shared-platform mention to
// the (already-existing, exact-name-match) X4fovsp model.
const freshProposal = {
  hasMultipleGenerations: true,
  generations: [
    { code: "X3fovsp", yearStart: 2003, yearEnd: 2010, designers: [], engineers: [], sharedPlatforms: [] },
    { code: "G01", yearStart: 2017, yearEnd: null, designers: [], engineers: [], sharedPlatforms: ["TestBMWfovsp X4fovsp"] },
  ],
};
window.LLM_FAMILIES = {
  families: {}, relations: {},
  recheck: {
    [FAM_ID]: {
      status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "TestBMWfovsp X3fovsp",
      proposal: freshProposal, discrepancy: "generation codes need correcting",
      attempts: 1, feedback: [],
    },
  },
  __serverAvailable: true,
};
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setLlmCheck(true);
const x3 = cw.byId.get(FAM_ID);

cw.openDetail(x3);
const yesBtn = window.document.querySelector(".dt-llmcheck .llm-yes");
check("override Accept button rendered", !!yesBtn);
yesBtn.onclick();

// Real behavior change (multi-generation-pair support, task #106): this key
// is now scoped to the SPECIFIC generation that carried the mention (G01),
// not the whole X3 nameplate -- so a DIFFERENT X3 generation mentioning its
// own (same or different) platform partner gets its own independent entry
// instead of colliding with this one. See llm_families.js's
// resolveOnePlatformMention for the full reasoning.
const key = [G01_ID, X4_ID].sort().join("|") + "|platform";
const rel = window.LlmFamilies.relationEntryFor(key);
check("BEFORE this fix, an override's shared-platform mention never resolved at all -- NOW it does", !!rel, rel);
check("auto-confirmed (exact nameplate-name match)", rel && rel.status === "confirmed", rel && rel.status);

const x4n = cw.byId.get(X4_ID);
const link = cw.links.find(l => l.type === "platform" &&
  ((l.sn === x4n && l.tn && l.tn.label && l.tn.label.includes("G01")) ||
   (l.tn === x4n && l.sn && l.sn.label && l.sn.label.includes("G01"))));
check("real graph link between G01 and X4fovsp exists", !!link, link);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
