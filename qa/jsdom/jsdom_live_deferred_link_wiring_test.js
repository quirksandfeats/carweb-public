// "Something is completely broken now. When I try to access anything now
// (after I had clicked apply), the graph no longer responds whatsoever, almost
// as if the entire program bricked itself... you can check it for yourself if
// you load up the webpage and attempt to search for a car - absolutely nothing
// happens other than the card for the car showing up."
//
// Found in the live page, not by reading the code: sim.tick() was throwing
//   TypeError: Cannot create property 'vx' on string 'm-bmw-vision-neue-klasse'
// on every single frame. The render loop catches its own exceptions and skips
// the frame, so nothing reaches the console except that warning and the canvas
// simply stops -- while the detail card, which is plain DOM, keeps rendering.
// That is precisely "only the card shows up".
//
// The cause: the live layer's DEFERRED connections. A connection DBpedia
// states between a harvested car and one the local model created cannot be
// placed when data_live.js runs -- that car does not exist yet -- so
// applyToOverlay places it at the end of boot instead, by pushing it onto the
// links array. Pushing is not enough. d3's link force turns endpoint ids into
// node references once, when it initializes; a link that arrives afterwards
// still has a string where the force expects a node, and the first tick dies
// trying to write velocity to it. It also never got sn/tn, which is what the
// renderer draws from.
//
// So this boots the whole page twice: once to find a nameplate the LLM layer
// created (the kind of endpoint that can only be deferred), then again with a
// live layer holding a deferred connection to it -- and insists the
// simulation still runs.
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

// One real page load: the same script order index.html uses, the same
// synchronous seeding of both overlays, then boot().
async function load(liveLayer) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.getBoundingClientRect = () =>
    ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => new Promise(() => {});          // no DBpedia round in this test
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;

  const warns = [];
  const realWarn = console.warn, realError = console.error, realLog = console.log, realInfo = console.info;
  window.console = {
    log: () => {}, info: () => {}, debug: () => {},
    warn: (...a) => warns.push(a.map(String).join(" ")),
    error: (...a) => warns.push("ERROR " + a.map(x => (x && x.stack) || String(x)).join(" ")),
  };
  const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  ev("d3.min.js"); ev("data.js");
  ev("llm_families_data.js");
  window.LLM_FAMILIES = Object.assign({ families: {} }, window.LLM_FAMILIES_STATIC, { __serverAvailable: false });
  ev("llm_families.js");
  if (liveLayer) window.LIVE_LAYER_STATIC = liveLayer;
  window.LIVE_LAYER = Object.assign({ newNodes: [], newLinks: [], updates: {} },
                                    window.LIVE_LAYER_STATIC, { __serverAvailable: false });
  ev("data_live.js");
  // Everything the graph holds BEFORE app.js runs. A connection can only be
  // deferred if one of its ends is missing from this set: that is the whole
  // condition, and picking an endpoint that is in it would quietly test the
  // ordinary boot splice instead.
  const preAppIds = new Set(window.CARDATA.nodes.map(n => n.id));
  ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
  window.CarWeb.boot();
  await new Promise(r => setTimeout(r, 60));
  console.warn = realWarn; console.error = realError; console.log = realLog; console.info = realInfo;
  return { window, warns, preAppIds };
}

(async () => {
  // ---------- pass 1: what can even be deferred ----------
  const first = await load(null);
  const D0 = first.window.CARDATA;
  // The far end: a car that the local model's overlay creates during boot, so
  // it is absent when data_live.js runs and present by the time the page is
  // up. This is the real shape -- "fam-bmw-3-series -> m-bmw-vision-neue-klasse".
  const born = D0.nodes.filter(n => !first.preAppIds.has(n.id) && !n.retired &&
                                    (n.type === "model" || n.type === "family"));
  // Prefer a real car over one of the merge bookkeeping nodes.
  const far = born.find(n => !/^merge-/.test(n.id)) || born[0];
  const fam = D0.nodes.find(n => first.preAppIds.has(n.id) && n.type === "family" && !n.retired);
  check("boot creates cars the live layer could not have placed earlier", !!far, far && far.id);
  check("...and there is a baked nameplate to connect one of them to", !!fam, fam && fam.id);
  if (!fam || !far) { console.log("\n1 FAILURE(S)"); process.exit(1); }

  const VERSION = D0.meta.version, GENERATED = D0.meta.generated;

  // ---------- pass 2: the delta an Apply leaves behind ----------
  // Shaped exactly like the one in the wild: endpoints by id, `deferred` set,
  // and the far end is a car that does not exist until boot builds it -- so
  // only applyToOverlay can place it, which is where the freeze lived.
  const layer = {
    version: VERSION, generated: GENERATED, savedAt: Date.now(),
    newNodes: [], updates: {},
    newLinks: [{ source: fam.id, target: far.id, type: "succession", deferred: true }],
  };
  const second = await load(layer);
  check("the deferred end really was invisible to the boot splice",
        !second.preAppIds.has(far.id), far.id);
  const w = second.window, cw = w.CarWeb, D = w.CARDATA;

  // The freeze itself.
  let tickErr = null;
  try { cw.simTick(4); } catch (e) { tickErr = e.message; }
  check("the simulation still ticks once a deferred connection has been placed",
        tickErr === null, tickErr);
  let drawErr = null;
  try { cw.graphDrawNow(); } catch (e) { drawErr = e.message; }
  check("and the canvas still draws", drawErr === null, drawErr);
  check("the render loop reported no skipped frames",
        !second.warns.some(t => /render loop error/i.test(t)),
        second.warns.filter(t => /render loop error/i.test(t))[0]);

  // Why it froze: the link went in unwired.
  const unwired = D.links.filter(l => !l.sn || !l.tn);
  check("every link in the graph knows both of its node objects",
        unwired.length === 0, unwired.length + " without sn/tn");
  const strung = D.links.filter(l => {
    const s = typeof l.source === "string" ? l.source : l.source && l.source.id;
    return !D.links.length ? false : !s;
  });
  check("...and every link still names resolvable endpoints", strung.length === 0, strung.length);

  // And it is actually there, not merely harmless.
  const placed = D.links.filter(l =>
    l.type === "succession" &&
    ((l.sn === cw.byId.get(fam.id) && l.tn === cw.byId.get(far.id)) ||
     (l.tn === cw.byId.get(fam.id) && l.sn === cw.byId.get(far.id))));
  check("the deferred connection was placed, and wired to both cars", placed.length === 1, placed.length);
  const adjHas = (cw.adj.get(fam.id) || []).some(e => e.n && e.n.id === far.id);
  check("...and reached the adjacency index, so focus and the ring can see it", adjHas);

  // Idempotence: the second pass at the end of boot, and every live LLM
  // mutation after it, calls this again.
  const before = D.links.length;
  w.CarWebLive.applyToOverlay();
  check("applying it again adds nothing twice", D.links.length === before,
        D.links.length + " vs " + before);

  // A dangling entry must be dropped, not allowed to take the simulation
  // down with it -- the second line of defence in buildSim.
  D.links.push({ source: fam.id, target: "m-does-not-exist-anywhere", type: "related" });
  let rebuildErr = null;
  try { cw.rebuildSim(); cw.simTick(2); } catch (e) { rebuildErr = e.message; }
  check("a link with an endpoint the graph doesn't have is dropped, not fatal",
        rebuildErr === null, rebuildErr);
  check("...and it really is gone from the links array",
        !D.links.some(l => (typeof l.target === "string" ? l.target : l.target && l.target.id)
                           === "m-does-not-exist-anywhere"));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
