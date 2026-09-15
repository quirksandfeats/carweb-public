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
check("the view's script is loaded by the page", srcs.indexOf("powertrain.js") >= 0, srcs.join(" "));
for (const f of srcs) {
  if (f === "llm_families.js") {
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const PT = window.CarWebPower;
const DATA = window.CARDATA;

// ---------- 1. the tab exists and is separate ----------
{
  const tabs = [...window.document.querySelectorAll("#viewtabs .tab")].map(b => b.dataset.view);
  check("a Powertrain tab sits alongside the others", tabs.indexOf("power") >= 0, tabs.join(", "));
  check("...with its own view container and canvas",
        !!window.document.getElementById("view-power") && !!window.document.getElementById("ptcanvas"));
}

// ---------- 2. before anything is scanned ----------
{
  PT.init();
  const c = PT.counts();
  check("an unscanned graph has no powertrain in it", c.engines === 0 && c.fitted === 0,
        JSON.stringify(c));
  cw.switchView("power");
  check("...and the view says so rather than drawing an empty canvas",
        /nothing scanned/.test(window.document.getElementById("pt-counts").textContent),
        window.document.getElementById("pt-counts").textContent);
  cw.switchView("graph");
}

// ---------- 3. the main graph, before and after ----------
const countsBefore = window.document.getElementById("counts").textContent;
const visibleNodesBefore = DATA.nodes.filter(n => cw.nodeInLayer(n)).length;
const visibleLinksBefore = DATA.links.filter(l => cw.linkInLayer(l)).length;

const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");
const article = LF.readEngineArticle(M256, "M256");
const applied = LF.applyEngineArticleWith(article, "Mercedes-Benz M256 engine",
                                          DATA.nodes, DATA.links, new Map(), {});

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

// ---------- 4. what the view gathers ----------
{
  PT.activate();
  const c = PT.counts();
  check("the view finds the engine", c.engines === 1, JSON.stringify(c));
  check("...its three variants", c.variants === 3, c.variants);
  check("...the cars it reaches", c.cars > 0, c.cars);
  check("...and the connections between them", c.fitted > 0, c.fitted);
  check("it does NOT drag in every other car in the graph",
        c.cars < 60, c.cars + " cars for one engine");

  cw.switchView("power");
  const bar = window.document.getElementById("pt-counts").textContent;
  check("the bar reports what is there", /1 engine/.test(bar) && /3 variants/.test(bar), bar);
  check("...and the view is the active one",
        window.document.getElementById("view-power").classList.contains("active"));
  cw.switchView("graph");
  check("switching back leaves the graph active",
        window.document.getElementById("view-graph").classList.contains("active"));
}

// ---------- 5. cars are shared, not copied ----------
{
  const fitted = DATA.links.filter(l => l.type === "fitted");
  const carIds = new Set(fitted.map(l => l.target));
  const shared = [...carIds].map(id => DATA.nodes.find(n => n.id === id)).filter(Boolean);
  check("every car an engine reaches is a node the main graph already had",
        shared.every(n => n.type === "model" || n.type === "family"),
        shared.map(n => n.type).join(","));
  check("...the same object, not a powertrain-only copy",
        shared.every(n => DATA.nodes.indexOf(n) >= 0));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
