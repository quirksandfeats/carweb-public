// Real user request: "if i click on the company name (mark) itself, i also
// want it to show the shared platforms/relations to other cars in different
// companies, so it should include the edge connection and the model/
// nameplate that it is related to outside of the mark as well. Therefore,
// the viewing window should also be adjusted to show this."
//
// Before this fix, clicking a make/company node only pulled its own direct
// children (nameplates/models linked via "made") into the focus set --
// neighborhoodForFocus's plain one-hop neighborhood(make.id) never reaches a
// platform/related/succession link, since that link lives on the CHILD
// nameplate, not on the make node itself. Uses the same real BMW X1 <->
// Zinoro 60H cross-company pair already exercised in
// jsdom_relation_mirror_test.js (a real build-time mirror link, BMW and
// Zinoro being different makes).
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

const bmwMake = [...cw.byId.values()].find(n => n.type === "make" && n.label === "BMW");
const x1 = cw.byId.get("fam-bmw-x1");
const zinoro = cw.byId.get("m-zinoro-zinoro-60h");
check("BMW make node exists (test precondition)", !!bmwMake);
check("BMW X1 family exists (test precondition)", !!x1 && x1.make === "BMW");
check("Zinoro 60H exists and is a DIFFERENT make (test precondition)", !!zinoro && zinoro.make !== "BMW", zinoro && zinoro.make);
const mirrorLink = cw.links.find(l => l.type === "related" && l.mirror &&
  ((l.sn === x1 && l.tn === zinoro) || (l.sn === zinoro && l.tn === x1)));
check("BMW X1 <-> Zinoro 60H mirror link exists (test precondition)", !!mirrorLink);

console.log("\n--- clicking the BMW make node ---");
cw.goto(bmwMake.id);
const focusSet = cw.graphFocusSet();
check("BMW X1 (BMW's own nameplate) is in the focus set", focusSet.has(x1.id));
check("Zinoro 60H (a DIFFERENT company's car, related via a shared platform) is ALSO pulled into the focus set",
  focusSet.has(zinoro.id));
// This used to assert the MIRROR link specifically was in-layer. It isn't
// any more, and that's the mirror-precedence rule working rather than a
// regression: focusOn now calls revealRelatedFor, which expands exactly the
// far nameplates a platform/related/succession link points at (real user
// request: "I want all of the cars that are related to immediately be
// revealed as well when I click on a particular model (or make)") -- and
// linkInLayer has always hidden a family-level mirror the moment its family
// is expanded, in favour of the real generation-level link underneath it.
// So the connection is still drawn, just by the more specific link. What
// actually matters here -- and what this now checks -- is that the
// cross-company connection is represented by exactly ONE visible link, never
// zero and never both at once.
const x1ToZinoro = cw.links.filter(l => l.type === "related" && !l.retired &&
  ((l.sn === zinoro || l.tn === zinoro)) &&
  [l.sn, l.tn].some(e => e === x1 || (e && e.familyOf === x1.id)));
const visible = x1ToZinoro.filter(l => cw.linkInLayer(l) && cw.nodeInLayer(l.sn) && cw.nodeInLayer(l.tn));
check("the cross-company connection is represented by exactly one visible link (never zero, never doubled)",
  visible.length === 1, `${visible.length} of ${x1ToZinoro.length} candidate links visible`);
check("...and it's the specific generation-level link, not the coarse family mirror", visible[0] && !visible[0].mirror);

console.log("\n--- the viewport actually includes the cross-company node, not just BMW's own lineup ---");
const t = cw.graphTransform();
// world-space -> screen-space, same transform draw() itself applies.
const zx = zinoro.x * t.k + t.x, zy = zinoro.y * t.k + t.y;
check("Zinoro 60H's screen position falls within the visible canvas after the fly-to",
  zx > -50 && zx < 1050 && zy > -50 && zy < 850, `${zx},${zy}`);

console.log("\n--- scope check: this does NOT balloon into a full second hop (designers/engineers of BMW's own nameplates stay out) ---");
// Any person credited as designer/engineer on a BMW nameplate should NOT be
// pulled into focus just by being two hops from the make -- only
// platform/related/succession links to a genuinely different make qualify.
const boundDesignerLinks = cw.links.filter(l => l.type === "designed" && l.sn && l.sn.make === "BMW");
const someDesigner = boundDesignerLinks.length ? boundDesignerLinks[0].tn : null;
check("(test precondition) at least one BMW nameplate has a credited designer in the real data", !!someDesigner);
check("that designer is NOT swept into the make-level focus set (would over-broaden it)",
  !someDesigner || !focusSet.has(someDesigner.id));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
