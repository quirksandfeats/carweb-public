// Real user report: "In the 'overview' mode when not focusing on the [A-Class]
// nameplate... there will only be a connection from nameplate to nameplate...
// However, when clicking on an individual model that happens to be a
// nameplate, then that initial connection might vanish and be replaced by
// the specific generation that the connection is associated with. That's
// what I want to display. Additionally, if the 'destination' node is also a
// nameplate, then the edge should be connected to the specific generation of
// the nameplate (if available. Otherwise, the connection would default to
// the nameplate.)"
//
// Root cause: the coarse family-to-family "mirror" link and the real
// generation-to-generation link already both exist in the data (see
// build_family_layer.py's mirror_relation_links / the mirror-hide
// precedence in linkInLayer). Expanding a nameplate correctly hides the
// coarse mirror once its OWN family is in expandedFamilies -- but the real
// specific link only draws if BOTH endpoints individually pass nodeInLayer,
// which requires the OTHER side's nameplate to ALSO be separately expanded.
// Without the fix (computePlatformsFilter's "pass 2" + inGraphView's
// platformsRevealedIds bypass), clicking just one side made the connection
// vanish entirely instead of being replaced, exactly the bug reported.
//
// Uses REAL production data rather than synthetic seeds -- Porsche 911 and
// Boxster/Cayman are exactly this shape: a fam-to-fam mirror (tagged with
// BOTH mirrorSourceFam and mirrorTargetFam, confirmed in
// jsdom_relation_mirror_test.js) standing in for a real, specific
// generation-to-generation "related" link between 911 (997) and
// Boxster/Cayman (987).
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
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
window.LLM_FAMILIES = { families: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

const p911 = cw.byId.get("fam-porsche-911");
const boxster = cw.byId.get("fam-porsche-boxster-and-cayman");
const gen997 = cw.byId.get("m-porsche-911-997");
const gen987 = cw.byId.get("m-porsche-boxster-and-cayman-987");
check("Porsche 911 family exists (test precondition)", !!p911 && p911.type === "family");
check("Boxster/Cayman family exists (test precondition)", !!boxster && boxster.type === "family");
check("911 (997) generation exists (test precondition)", !!gen997 && gen997.familyOf === p911.id);
check("Boxster/Cayman (987) generation exists (test precondition)", !!gen987 && gen987.familyOf === boxster.id);
const realLink = cw.links.find(l => l.type === "related" && !l.mirror &&
  ((l.sn === gen997 && l.tn === gen987) || (l.sn === gen987 && l.tn === gen997)));
check("the real, specific 997 <-> 987 link exists in the data (test precondition)", !!realLink);
const mirrorLink = cw.links.find(l => l.type === "related" && l.mirror &&
  ((l.sn === p911 && l.tn === boxster) || (l.sn === boxster && l.tn === p911)));
check("the coarse fam-to-fam mirror exists too (test precondition)", !!mirrorLink);

console.log("\n--- overview mode: coarse nameplate-to-nameplate connection only ---");
cw.setPlatformsOnly(true);
let ids = cw.graphPlatformsNodeIds();
check("neither family expanded by default", !cw.isFamilyExpanded(p911.id) && !cw.isFamilyExpanded(boxster.id));
check("911 nameplate is shown", ids.has(p911.id));
check("Boxster/Cayman nameplate is shown", ids.has(boxster.id));
check("the specific 997 generation is NOT shown yet -- overview stays at nameplate granularity", !ids.has(gen997.id));
check("the specific 987 generation is NOT shown yet -- overview stays at nameplate granularity", !ids.has(gen987.id));
check("the coarse mirror link is the one actually reachable right now", cw.linkInLayer(mirrorLink));

console.log("\n--- clicking the 911 nameplate: the coarse connection is replaced by the specific generation ---");
cw.goto(p911.id);
check("911 is now expanded", cw.isFamilyExpanded(p911.id));
// This used to assert Boxster/Cayman stayed COLLAPSED, and that its 987
// generation was surfaced only through platformsRevealedIds -- a narrow
// "quietly bypass the collapse gate for this one node" mechanism built
// specifically so the connection wouldn't vanish when only one side was
// clicked. A direct user request has since replaced the workaround with the
// real thing: "some cars that state they are related for a particular model
// do not show up in the knowledge graph as being connected, until I click to
// reveal them. I want all of the cars that are related to immediately be
// revealed as well when I click on a particular model (or make)." app.js's
// revealRelatedFor (called from focusOn) now expands the far nameplate of a
// platform/related/succession link outright, so 987 is genuinely visible
// rather than specially exempted -- which is strictly more correct
// everywhere else too (it's now clickable, hoverable, and shows in the
// detail panel like any other visible node). platformsRevealedIds itself is
// kept: it still covers the cases revealRelatedFor doesn't reach, e.g. the
// filter recomputing after a collapse elsewhere.
check("Boxster/Cayman is now expanded too -- the related nameplate is revealed on the same click", cw.isFamilyExpanded(boxster.id));
check("the coarse mirror is now hidden (more specific link takes over)", !cw.linkInLayer(mirrorLink));
ids = cw.graphPlatformsNodeIds();
check("911's own specific generation (997) is now shown", ids.has(gen997.id));
check("the connection did NOT just vanish -- Boxster/Cayman's specific generation (987) is shown too",
  ids.has(gen987.id));
check("987 now passes the ordinary global nodeInLayer check -- it's genuinely visible, not specially exempted", cw.nodeInLayer(gen987));
check("the specific 997 <-> 987 link is reachable (both endpoints visible, mirror stood aside)",
  cw.linkInLayer(realLink) && cw.nodeInLayer(realLink.sn) && cw.nodeInLayer(realLink.tn));

console.log("\n--- the revealed connection is actually part of the live focus/highlight, not just background clutter ---");
const focusSet = cw.graphFocusSet();
check("997 is in the focus set", focusSet.has(gen997.id));
check("987 (the revealed destination generation) is in the focus set too", focusSet.has(gen987.id));

console.log("\n--- collapsing 911 again restores the coarse overview connection ---");
// Both sides were expanded by the click, so both have to come back down for
// the coarse overview connection to be the right thing to show again.
cw.collapseFamily(p911.id);
cw.collapseFamily(boxster.id);
ids = cw.graphPlatformsNodeIds();
check("mirror link is reachable again", cw.linkInLayer(mirrorLink));
check("987 is hidden again once both nameplates collapse back", !cw.nodeInLayer(gen987));
check("987 is not quietly revealed either", !cw.graphPlatformsRevealedIds().has(gen987.id));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
