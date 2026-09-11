// Verifies designer/engineer nodes + links get wired up for LLM-confirmed
// generations, mirrored to the family node too, and that the topbar/control
// bar overflow fixes are in place.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
// strip comments before testing so an explanatory /* ... overflow-x:auto ... */
// comment can't be mistaken for an actual applied declaration
const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

// ---------- CSS checks ----------
check("#topbar scrolls horizontally instead of clipping", /#topbar\{[^}]*overflow-x:auto/.test(css));
check("#controlbar does NOT use overflow-x:auto (would clip the search-results dropdown below it)",
  !/#controlbar\{[^}]*overflow-x:auto/.test(css));
check("#controlbar wraps instead (year slider drops to its own line if needed)",
  /#controlbar\{[^}]*flex-wrap:wrap/.test(css));

// ---------- live app: designer/engineer wiring ----------
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
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });

const TEST_ID = "m-dacia-logan";
// Gen 1's designer is a name that ALREADY exists in the real graph (Giorgetto
// Giugiaro -- one of the most-credited designers in data.js) to test reuse;
// Gen 2's designer is a brand-new name to test minting; the same brand-new
// name also appears as GEN 2's engineer to test role-merging on one person;
// Gen 3 repeats Gen 1's designer to test the family-level mirror dedupes to
// ONE line, not two.
const seeded = {
  families: {
    [TEST_ID]: {
      status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "Dacia Logan",
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "Phase 1", yearStart: 2004, yearEnd: 2012, designers: ["Giorgetto Giugiaro"], engineers: [] },
          { code: "Phase 2", yearStart: 2012, yearEnd: 2020, designers: ["Balázs Filczer"], engineers: ["Balázs Filczer"] },
          { code: "Phase 3", yearStart: 2020, yearEnd: null, designers: ["Giorgetto Giugiaro"], engineers: [] },
        ],
      },
      attempts: 1, feedback: [],
    },
  },
};
window.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { this.status = 200; this.responseText = JSON.stringify(seeded); };
};
global.window = window;
global.document = window.document;
function loadScript(file) { window.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
(function () {
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = xhr.status === 200 ? JSON.parse(xhr.responseText) : { families: {} };
  data.__serverAvailable = xhr.status === 200;
  window.LLM_FAMILIES = data;
})();
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;

const giugiaro = [...cw.byId.values()].find(n => n.type === "person" && n.label === "Giorgetto Giugiaro");
check("Giorgetto Giugiaro already exists as a person node in the real data (test precondition)", !!giugiaro);
const giugiaroDegBefore = giugiaro.deg;
const nodesBeforeCount = cw.nodes.length;

const before = cw.byId.get(TEST_ID);
// Real user request: a first-time nameplate creation needs no manual
// approval -- opening the detail panel on this already-seeded "provisional"
// entry auto-applies it immediately.
cw.openDetail(before);

const after = cw.byId.get(TEST_ID);
const [g1, g2, g3] = after.generations.map(id => cw.byId.get(id));

// ---------- reuse an existing person ----------
const giugiaroAfter = cw.byId.get(giugiaro.id);
check("Giugiaro was REUSED, not duplicated (same node object)", giugiaroAfter === giugiaro);
const giugiaroDesignedLinks = cw.links.filter(l => l.type === "designed" && l.tn === giugiaro);
check("Gen 1 (Phase 1) links directly to Giugiaro", !!giugiaroDesignedLinks.find(l => l.sn === g1));
check("Gen 3 (Phase 3) links directly to Giugiaro too", !!giugiaroDesignedLinks.find(l => l.sn === g3));
check("the family node ALSO links to Giugiaro (parent-level line)", !!giugiaroDesignedLinks.find(l => l.sn === after));
const famToGiugiaro = giugiaroDesignedLinks.filter(l => l.sn === after);
check("...but only ONCE, deduped (Phase 1 and Phase 3 both credit him)", famToGiugiaro.length === 1, famToGiugiaro.length);
check("Giugiaro's degree/radius were refreshed even though he's a pre-existing node",
  giugiaro.deg > giugiaroDegBefore, `${giugiaroDegBefore} -> ${giugiaro.deg}`);

// ---------- mint a brand-new person ----------
const filczer = [...cw.byId.values()].find(n => n.type === "person" && n.label === "Balázs Filczer");
check("a new person node was minted for Balázs Filczer", !!filczer);
check("new person node has a proper id prefix", filczer && filczer.id.startsWith("p-"), filczer && filczer.id);
check("new person's roles include BOTH designer and engineer (credited as both on Gen 2)",
  filczer && filczer.roles.includes("designer") && filczer.roles.includes("engineer"), filczer && filczer.roles);
const filczerDesigned = cw.links.find(l => l.type === "designed" && l.sn === g2 && l.tn === filczer);
const filczerEngineered = cw.links.find(l => l.type === "engineered" && l.sn === g2 && l.tn === filczer);
check("Gen 2 (Phase 2) links to Filczer as designed", !!filczerDesigned);
check("Gen 2 (Phase 2) links to Filczer as engineered", !!filczerEngineered);
const famToFilczerDesigned = cw.links.find(l => l.type === "designed" && l.sn === after && l.tn === filczer);
const famToFilczerEngineered = cw.links.find(l => l.type === "engineered" && l.sn === after && l.tn === filczer);
check("family node also links to Filczer as designed (parent-level line)", !!famToFilczerDesigned);
check("family node also links to Filczer as engineered (parent-level line)", !!famToFilczerEngineered);

// ---------- new person node was properly reindexed (byId/adj/deg/r) ----------
check("new person node is in byId", cw.byId.get(filczer.id) === filczer);
check("new person node is in adj map", cw.adj.has(filczer.id));
check("new person node has a degree > 0", filczer.deg > 0, filczer.deg);
check("new person node has a radius set", typeof filczer.r === "number" && filczer.r > 0, filczer.r);
check("new person node is visible (not hidden by layer/family logic)", cw.nodeInLayer(filczer));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
