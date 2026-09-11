// Verifies task #53: a family mirrors its generations' designed/engineered
// links up to itself, so while the nameplate is COLLAPSED the family-level
// line is the only one visible (its generations are hidden). Once EXPANDED,
// the generation-level line should take over and the family-level line
// should disappear -- never both at once. Uses the real baked data.js
// (Porsche 911 family, freshly re-grouped this session) as the fixture.
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
// default year range starts at 2000 -- widen it so the (1993-1998) 993
// generation used below isn't excluded by the slider itself, independent
// of the family-expansion behavior actually under test here.
cw.setYearRange(1900, cw.yearRange().max);

const fam = cw.byId.get("fam-porsche-911");
check("Porsche 911 family node exists (test precondition, freshly re-grouped this session)", !!fam);
const gen993 = cw.byId.get("m-porsche-911-993");
check("911 (993) generation exists and belongs to the family", !!gen993 && gen993.familyOf === "fam-porsche-911");

const famDesignedLinks = cw.links.filter(l => l.type === "designed" && l.sn === fam);
const gen993DesignedLinks = cw.links.filter(l => l.type === "designed" && l.sn === gen993);
check("family node has at least one mirrored designed-link (test precondition)", famDesignedLinks.length > 0, famDesignedLinks.length);
check("the 993 generation has its own direct designed-link too (test precondition)", gen993DesignedLinks.length > 0, gen993DesignedLinks.length);

// ---------- collapsed: only the family-level line should be in-layer ----------
check("family not expanded by default", !cw.isFamilyExpanded(fam.id));
check("COLLAPSED: family-level designed link IS in-layer", famDesignedLinks.every(l => cw.linkInLayer(l)));
// linkInLayer() itself doesn't hide generation-level links when collapsed --
// that's nodeInLayer's job (the generation node itself is hidden), which is
// why the combined reachable() check further below is what actually matters
// (it mirrors the exact condition draw()/neighborhood() use).
check("COLLAPSED: the 993 generation node itself is hidden (nodeInLayer)", !cw.nodeInLayer(gen993));

// ---------- expanded: generation-level line should take over ----------
cw.expandFamily(fam.id);
check("family now expanded", cw.isFamilyExpanded(fam.id));
check("EXPANDED: the 993 generation node is now visible (nodeInLayer)", cw.nodeInLayer(gen993));
check("EXPANDED: family-level designed link is now HIDDEN (generation-level wins)",
  famDesignedLinks.every(l => !cw.linkInLayer(l)));
check("EXPANDED: generation-level designed link is now visible",
  gen993DesignedLinks.every(l => cw.linkInLayer(l)));

// ---------- collapse again: family-level line should come back ----------
cw.collapseFamily(fam.id);
check("family collapsed again", !cw.isFamilyExpanded(fam.id));
check("COLLAPSED AGAIN: family-level designed link is back in-layer", famDesignedLinks.every(l => cw.linkInLayer(l)));
check("COLLAPSED AGAIN: the 993 generation node is hidden again (nodeInLayer)", !cw.nodeInLayer(gen993));

// ---------- draw()/neighborhood()'s exact visibility condition ----------
// Both the render loop and focus-neighborhood walk use precisely
// `inGraphView(n) && linkInLayer(l)` (inGraphView = nodeInLayer && passesYearFilter)
// to decide whether a link's far endpoint counts as reachable/visible.
// Reproduce that condition directly for the designer shared between the
// family-level and generation-level links, expanded vs collapsed.
function reachable(l) {
  return cw.linkInLayer(l) && cw.nodeInLayer(l.sn) && cw.nodeInLayer(l.tn) && cw.passesYearFilter(l.sn) && cw.passesYearFilter(l.tn);
}
cw.collapseFamily(fam.id);
check("COLLAPSED: family-level link is reachable, generation-level is not",
  famDesignedLinks.some(reachable) && !gen993DesignedLinks.some(reachable));
cw.expandFamily(fam.id);
check("EXPANDED: generation-level link is reachable, family-level is not (no double connection)",
  gen993DesignedLinks.some(reachable) && !famDesignedLinks.some(reachable));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
