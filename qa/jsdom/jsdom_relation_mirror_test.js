// Verifies task #56's deterministic half: platform/related/succession links
// whose real endpoint is a generation folded into a collapsed nameplate now
// get mirrored up to the family node too (build_family_layer.py's
// mirror_relation_links), and that mirror follows the SAME hide-when-
// expanded precedence as the designed/engineered mirror from task #53 --
// never deleting the original, more specific link, just hiding the
// redundant collapsed-view stand-in once a more specific view is available.
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
global.window = window;
global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
window.LLM_FAMILIES = { families: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
  loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

const x1 = cw.byId.get("fam-bmw-x1");
const f48 = cw.byId.get("m-bmw-x1-f48");
const zinoro = cw.byId.get("m-zinoro-zinoro-60h");
const mirrorLink = cw.links.find(l => l.type === "related" && l.mirror &&
  ((l.sn === x1 && l.tn === zinoro) || (l.sn === zinoro && l.tn === x1)));
const realLink = cw.links.find(l => l.type === "related" && l.sn === f48 && l.tn === zinoro);
check("build-time mirror link fam-bmw-x1 <-> Zinoro 60H exists (test precondition)", !!mirrorLink);
check("original F48 -> Zinoro 60H link still exists untouched (never deleted)", !!realLink);
check("mirror is tagged with mirrorSourceFam pointing at the X1 family", mirrorLink.mirrorSourceFam === x1.id);

// ---------- collapsed: only the mirror should be reachable ----------
check("X1 family not expanded by default", !cw.isFamilyExpanded(x1.id));
check("COLLAPSED: mirror link is in-layer", cw.linkInLayer(mirrorLink));
check("COLLAPSED: original link's own source (F48) is hidden (nodeInLayer)", !cw.nodeInLayer(f48));

// ---------- expanded: original should take over, mirror should hide ----------
cw.expandFamily(x1.id);
check("X1 now expanded", cw.isFamilyExpanded(x1.id));
check("EXPANDED: mirror link is now HIDDEN (more specific original takes over)", !cw.linkInLayer(mirrorLink));
check("EXPANDED: original F48 -> Zinoro link is fully reachable",
  cw.linkInLayer(realLink) && cw.nodeInLayer(realLink.sn) && cw.nodeInLayer(realLink.tn));

// ---------- collapse again: mirror should come back ----------
cw.collapseFamily(x1.id);
check("COLLAPSED AGAIN: mirror link is back in-layer", cw.linkInLayer(mirrorLink));
check("COLLAPSED AGAIN: F48 hidden again", !cw.nodeInLayer(f48));

// ---------- both-sides-grouped case: Porsche 911 <-> Boxster/Cayman ----------
const p911 = cw.byId.get("fam-porsche-911");
const boxster = cw.byId.get("fam-porsche-boxster-and-cayman");
check("both-sides family node precondition (Porsche 911 / Boxster-Cayman)", !!p911 && !!boxster);
const bothMirror = cw.links.find(l => l.type === "related" && l.mirror &&
  ((l.sn === p911 && l.tn === boxster) || (l.sn === boxster && l.tn === p911)));
check("fam-to-fam mirror exists when BOTH sides are grouped nameplates", !!bothMirror);
check("that mirror is tagged with BOTH mirrorSourceFam and mirrorTargetFam",
  !!bothMirror.mirrorSourceFam && !!bothMirror.mirrorTargetFam);
check("COLLAPSED: fam-to-fam mirror visible with neither side expanded", cw.linkInLayer(bothMirror));
cw.expandFamily(p911.id);
check("expanding JUST the 911 side hides the fam-to-fam mirror too (either side expanding is enough)",
  !cw.linkInLayer(bothMirror));
cw.collapseFamily(p911.id);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
