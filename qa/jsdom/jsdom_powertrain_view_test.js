// The powertrain view, and the promise that makes it safe: it is independent.
//
// Real user answer, asked where engines should appear: "New view only" -- the
// main graph untouched, same nodes, same counts, same layout. That is not a
// property of the new view at all; it is enforced from the other side, by
// app.js's nodeInLayer/linkInLayer refusing every engine node and edge. So
// most of this file is about what the MAIN graph does NOT do once an engine
// is in the shared node array.
//
// Driven by the real Mercedes-Benz M256 article over the real baked graph.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const CACHE = path.join(ROOT, "qa", "wiki_cache");
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
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;

const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
// Real user request, twice over: "I repeat, I want exactly the same behavior,
// UI, node behavior, etc.. as the graph tab view. It should look virtually
// identical." There is no second renderer any anymore -- that is what kept
// drifting -- so there is no powertrain.js to load.
check("there is no separate powertrain renderer to drift from the Graph's",
      srcs.indexOf("powertrain.js") < 0, srcs.join(" "));
for (const f of srcs) {
  if (f === "llm_families.js") {
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- 1. the tab shows the Graph view, in its powertrain layer ----------
{
  const doc = window.document;
  const tabs = [...doc.querySelectorAll("#viewtabs .tab")].map(b => b.dataset.view);
  check("a Powertrain tab sits alongside the others", tabs.indexOf("power") >= 0, tabs.join(", "));
  check("there is no separate powertrain view container", !doc.getElementById("view-power"));
  check("...nor a second canvas", !doc.getElementById("ptcanvas"));

  cw.switchView("power");
  check("the Powertrain tab shows the Graph's own view",
        doc.getElementById("view-graph").classList.contains("active"));
  check("...with the Powertrain tab marked active, not the Graph one",
        doc.querySelector('#viewtabs .tab[data-view="power"]').classList.contains("active") &&
        !doc.querySelector('#viewtabs .tab[data-view="graph"]').classList.contains("active"));
  check("...and the layer flipped", cw.graphMode() === "power", cw.graphMode());
  check("the Graph's legend gives way to the powertrain one",
        doc.getElementById("legend").hidden === true &&
        doc.getElementById("pt-legend").hidden === false);
  check("...which is the same legend pill, not a second kind of bar",
        doc.getElementById("pt-legend").classList.contains("legend-style"));
  check("the year slider is put away, as on every non-Graph tab",
        doc.getElementById("yearfilter").style.display === "none");
  check("nothing is scanned yet, and it says so",
        /nothing scanned/.test(doc.getElementById("pt-counts").textContent),
        doc.getElementById("pt-counts").textContent);
  cw.switchView("graph");
  check("switching back restores the Graph's legend",
        doc.getElementById("legend").hidden === false &&
        doc.getElementById("pt-legend").hidden === true);
  check("...and the main layer", cw.graphMode() === "main", cw.graphMode());
}

// ---------- 2. the main graph, before and after ----------
const countsBefore = window.document.getElementById("counts").textContent;
const visibleNodesBefore = DATA.nodes.filter(n => cw.nodeInLayer(n)).length;
const visibleLinksBefore = DATA.links.filter(l => cw.linkInLayer(l)).length;

const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");
const article = LF.readEngineArticle(M256, "M256");
const nodesBefore = DATA.nodes.length, linksBefore = DATA.links.length;
const applied = LF.applyEngineArticleWith(article, "Mercedes-Benz M256 engine",
                                          DATA.nodes, DATA.links, new Map(), {});
// What scanEngine does next, and every other live mutation: index what was
// just pushed. Without it the graph is half-built -- nodes in the array, in
// no index -- which is not a state the app is ever in.
cw.spliceIntoIndexes(nodesBefore, linksBefore);
cw.rebuildSim();

{
  check("the engine really did go into the shared node array",
        !!applied.engine && DATA.nodes.indexOf(applied.engine) >= 0);
  check("...with its variants", applied.variants === 3, applied.variants);
  check("...and real connections to cars", applied.fitted > 0, applied.fitted);

  check("no engine is visible in the main graph",
        DATA.nodes.filter(n => cw.nodeInLayer(n) && /^(engine|enginevar)$/.test(n.type)).length === 0);
  check("no fitted connection is either",
        DATA.links.filter(l => cw.linkInLayer(l) && l.type === "fitted").length === 0);
  check("nor the engine's own internal links",
        DATA.links.filter(l => cw.linkInLayer(l) && /^(enginegen|enginesucc)$/.test(l.type)).length === 0);

  check("the main graph shows exactly what it showed before",
        DATA.nodes.filter(n => cw.nodeInLayer(n)).length === visibleNodesBefore &&
        DATA.links.filter(l => cw.linkInLayer(l)).length === visibleLinksBefore,
        DATA.nodes.filter(n => cw.nodeInLayer(n)).length + " vs " + visibleNodesBefore);

  cw.refreshCounts();
  check("...and the footer counts do not move",
        window.document.getElementById("counts").textContent === countsBefore,
        window.document.getElementById("counts").textContent);

  check("a powertrain node is recognised as one", cw.isPowertrain(applied.engine));
  check("...and an ordinary car is not", !cw.isPowertrain(DATA.nodes.find(n => n.type === "model")));
}

// ---------- 3. the layer, and what it shows when ----------
// Real user request: "I also want that the car models associated with the
// engines only appear once I have clicked on a particular engine, similar to
// how I do so for the 'graph' tab view." Which is the nameplate rule exactly,
// so it IS the nameplate rule -- the same expandedFamilies set, the same
// radial ring, the same click.
{
  const eng = applied.engine;
  cw.switchView("power");
  cw.rebuildSim();
  const c = cw.powertrainCounts();
  check("the layer knows what is in it",
        c.engines === 1 && c.variants === 3 && c.fitted > 0, JSON.stringify(c));
  const bar = window.document.getElementById("pt-counts").textContent;
  check("the legend reports it", /1 engine/.test(bar) && /3 variants/.test(bar), bar);

  check("shut, the engine is on screen", cw.nodeInLayer(eng));
  check("...and nothing else is -- no variants",
        DATA.nodes.filter(n => n.type === "enginevar" && cw.nodeInLayer(n)).length === 0);
  check("...and no cars, which is the whole point",
        DATA.nodes.filter(n => (n.type === "model" || n.type === "family") && cw.nodeInLayer(n)).length === 0,
        DATA.nodes.filter(n => (n.type === "model" || n.type === "family") && cw.nodeInLayer(n)).length);
  check("...nor a designer or a make from the other layer",
        DATA.nodes.filter(n => cw.nodeInLayer(n) && (n.type === "person" || n.type === "make")).length === 0);

  // Clicking is what focusOn does, and focusOn is what the canvas click
  // handler calls -- for an engine exactly as for a nameplate.
  cw.Graph.gotoNode(eng);
  check("clicking the engine opens it", cw.isFamilyExpanded(eng.id));
  check("...its variants appear", DATA.nodes.filter(n => n.type === "enginevar" && cw.nodeInLayer(n)).length === 3,
        DATA.nodes.filter(n => n.type === "enginevar" && cw.nodeInLayer(n)).length);
  const carsOpen = DATA.nodes.filter(n => (n.type === "model" || n.type === "family") && cw.nodeInLayer(n));
  check("...and so do the cars it was fitted to", carsOpen.length > 0, carsOpen.length);
  check("...only those, not the rest of the graph", carsOpen.length < 60, carsOpen.length);

  // The ring: the same geometry a nameplate's generations get, because it is
  // the same function.
  const ring = cw.ringOf(eng.id);
  check("the variants are laid out on a radial ring around the engine", !!ring,
        ring && JSON.stringify({ r: Math.round(ring.r), n: ring.gens.size }));
  check("...one slot per variant", ring && ring.gens.size === 3, ring && ring.gens.size);
  const onRim = [...ring.gens].map(id => cw.byId.get(id))
    .every(v => Math.abs(Math.hypot(v.x - ring.x, v.y - ring.y) - ring.r) < 1.5);
  check("...actually sitting on it", onRim,
        [...ring.gens].map(id => { const v = cw.byId.get(id);
          return Math.hypot(v.x - ring.x, v.y - ring.y).toFixed(1); }).join(", "));

  // The force fields. Same clearRing/keep-out forces as the main layer, so a
  // car pulled at the engine still ends up outside its bubble.
  const car = carsOpen[0];
  car.x = ring.x + 3; car.y = ring.y + 3; car.vx = car.vy = 0;
  cw.simTick(60);
  const d = Math.hypot(car.x - ring.x, car.y - ring.y);
  check("a car dropped inside the engine's bubble is pushed back out",
        d >= ring.clear - 0.001, d.toFixed(1) + " vs clearance " + ring.clear.toFixed(1));

  // Real user request: "it would make more sense for the engines in the
  // powertrain tab to adopt the same coloring as if it were the 'makes' nodes
  // from the Graph tab, followed by the yellowish color you chose for the
  // engine variants, followed by the standard orange for the car nodes."
  const make = DATA.nodes.find(n => n.type === "make" && !n.retired);
  const someVar = DATA.nodes.find(n => n.type === "enginevar");
  check("an engine is sized on the same curve as a make, being its layer's hub",
        Math.abs(eng.r - Math.min(9 + eng.deg * 0.18, 26)) < 1e-9,
        eng.r + " (a make with the same degree: " + Math.min(9 + make.deg * 0.18, 26) + ")");
  check("...and a variant is not -- it is a child, like a generation",
        someVar.r < eng.r, someVar.r + " vs " + eng.r);

  cw.Graph.clearFocus();
  cw.switchView("graph");
}

// ---------- 4. cars are shared, not copied ----------
{
  const fitted = DATA.links.filter(l => l.type === "fitted");
  const carIds = new Set(fitted.map(l => typeof l.target === "string" ? l.target : l.target.id));
  const shared = [...carIds].map(id => DATA.nodes.find(n => n.id === id)).filter(Boolean);
  check("every car an engine reaches is a node the main graph already had",
        shared.every(n => n.type === "model" || n.type === "family"),
        shared.map(n => n.type).join(","));
  check("...the same object, not a powertrain-only copy",
        shared.every(n => DATA.nodes.indexOf(n) >= 0));
}

// ---------- 5. every piece of furniture is the Graph's own ----------
{
  const doc = window.document;
  const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
  check("the canvas is the Graph's", !!doc.getElementById("graphcanvas"));
  check("the hint line is the Graph's", !!doc.getElementById("graphhint"));
  check("the zoom control is the Graph's", !!doc.getElementById("zoomslider"));
  check("the release-focus button is the Graph's", !!doc.getElementById("clearfocus"));
  // Real user request: "there should be an auto scaling where the camera
  // initially is scaled down to fit all of the engines that it can, rather
  // than start out super zoomed out (specifically for the powertrain tab)."
  // fitAll took its extent over EVERY node in the array, so a layer holding
  // forty of them was framed as if the other six thousand were on screen.
  const appSrc = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
  const fit = appSrc.split("function fitAll(")[1].split("function activeSet")[0];
  check("the camera frames what is on screen, not the whole node array",
        /shown = nodes\.filter\(/.test(fit) && /inGraphView\(n\)/.test(fit) &&
        /d3\.extent\(shown/.test(fit), fit.slice(0, 80).replace(/\n/g, " "));
  check("...and switching into the layer settles it first, then frames it",
        /if \(isPowerMode\(\)\) Graph\.settleAndFit\(\)/.test(appSrc));

  check("no parallel powertrain furniture is left behind",
        !doc.getElementById("ptzoom") && !doc.getElementById("pt-hint") &&
        !/#ptcanvas|#view-power|#pt-bar/.test(css));

  // The hover card, driven through the Graph's own canvas: the same pointer
  // path a person takes.
  cw.switchView("power");
  const eng = DATA.nodes.find(n => n.type === "engine");
  cw.Graph.gotoNode(eng);
  cw.graphDrawNow();
  const t = cw.Graph.state().t;
  const at = t.apply([eng.x, eng.y]);
  const canvas = doc.getElementById("graphcanvas");
  const hc = doc.getElementById("hovercard");
  canvas.dispatchEvent(new window.MouseEvent("pointermove", {
    clientX: at[0], clientY: at[1], bubbles: true }));
  check("hovering an engine raises the same hover card the Graph uses",
        hc.hidden === false && hc.querySelector(".hc-title").textContent === eng.label,
        hc.hidden + " / " + hc.querySelector(".hc-title").textContent);
  check("...with the same kicker the Graph would show",
        hc.querySelector(".hc-kicker").textContent === cw.nodeKicker(eng),
        hc.querySelector(".hc-kicker").textContent);
  canvas.dispatchEvent(new window.MouseEvent("pointerleave", { bubbles: true }));
  check("...and it goes away on the way out", hc.hidden === true);
  cw.switchView("graph");
}

// ---------- 6. a nameplate never stands next to its own generation ----------
// Real user report, with a screenshot of the M119: "in the engine search, you
// can see both the nameplate and the individual generation of that nameplate
// (for example, the e class and the w124 e class). I don't want the nameplate
// to be shown at all if the generation is shown."
//
// planEngineEdges applies that rule when an engine ARTICLE is read. The
// E-Class edge in the screenshot came from an engine MENTION on a car's
// infobox, which never passes through it -- so this drives the mention path.
{
  const doc = window.document;
  const FAM = "fam-pt-eclass", GEN = "m-pt-eclass-w124", LONE = "m-pt-lone";
  const mk = cw.byId.get(DATA.nodes.find(n => n.type === "make").id);
  DATA.nodes.push(
    { id: FAM, type: "family", label: "E-Class", make: "TestPT", wp: "TestPT E-Class",
      generations: [GEN], designers: [], engineers: [] },
    { id: GEN, type: "model", label: "E-Class (W124)", make: "TestPT", familyOf: FAM,
      year: 1984, end: 1996, designers: [], engineers: [] },
    // A car with no nameplate of its own, to prove the rule is about the pair
    // and not about families in general.
    { id: LONE, type: "model", label: "Lone", make: "TestPT", year: 1990, designers: [], engineers: [] });
  DATA.links.push({ source: FAM, target: GEN, type: "generation" });
  const eng2 = { id: "eng-pt-m119", type: "engine", label: "M119", wp: "Mercedes-Benz M119 engine",
                 unresearched: true, variants: [] };
  DATA.nodes.push(eng2);
  // Exactly what a mention leaves behind: an edge at BOTH levels.
  DATA.links.push({ source: eng2.id, target: FAM, type: "fitted", fromCar: true },
                  { source: eng2.id, target: GEN, type: "fitted", fromCar: true },
                  { source: eng2.id, target: LONE, type: "fitted", fromCar: true });
  cw.spliceIntoIndexes(DATA.nodes.length - 4, DATA.links.length - 4);
  cw.switchView("power");
  cw.rebuildSim();
  cw.Graph.gotoNode(cw.byId.get(eng2.id));

  check("the generation is shown", cw.nodeInLayer(cw.byId.get(GEN)));
  check("...and its nameplate is not, since the generation covers it",
        !cw.nodeInLayer(cw.byId.get(FAM)));
  check("...nor is the edge to it drawn",
        !DATA.links.some(l => l.type === "fitted" && cw.linkInLayer(l) &&
          (l.target.id || l.target) === FAM));
  check("a car that has no nameplate of its own is unaffected",
        cw.nodeInLayer(cw.byId.get(LONE)));

  cw.openDetail(cw.byId.get(eng2.id));
  const listed = [...doc.querySelectorAll(".dt-power button")].map(b => b.textContent);
  check("the card agrees with the canvas: the generation, not the nameplate",
        listed.some(r => /E-Class \(W124\)/.test(r)) &&
        !listed.some(r => /^TestPT E-Class(?!\s*\()/.test(r.trim())),
        listed.join(" | ").slice(0, 120));

  // ---------- and clicking one of those cars does not empty the canvas ----------
  // Real bug report, with a screenshot: "now if I click on the cars connected,
  // it looks like the second screenshot I attached (basically it's completely
  // blank)." focusOn collapses the previous focus's auto-expansions before
  // opening this one's -- which shut the engine that was making the car
  // visible, at the instant it was clicked.
  cw.Graph.gotoNode(cw.byId.get(GEN));
  check("clicking a connected car keeps it on screen", cw.nodeInLayer(cw.byId.get(GEN)));
  check("...and the engine that reaches it, so the canvas is not empty",
        cw.nodeInLayer(cw.byId.get(eng2.id)));
  check("...with the car focused, not something else",
        [...(cw.graphFocusSet() || [])].indexOf(GEN) >= 0,
        [...(cw.graphFocusSet() || [])].length);
  check("...and its card is the car's own, the same node the Graph tab shows",
        doc.querySelector(".dt-title").textContent.indexOf("E-Class (W124)") >= 0,
        doc.querySelector(".dt-title").textContent);
  check("...still in the powertrain layer, not bounced back to the Graph",
        cw.graphMode() === "power", cw.graphMode());
  cw.Graph.clearFocus();
  cw.switchView("graph");
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
