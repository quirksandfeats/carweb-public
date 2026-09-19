// "The user can either select a car and have the LLM search it normally,
// after which the information about the engine also gets revealed. New nodes
// (in a new graph view) will appear with all of the engines that came up, but
// they will not get researched."
//
// The cheap half of the powertrain layer: while a car's wikitext is already in
// hand, note which engines it names. Nothing is followed -- that only happens
// when the engine itself is scanned -- so this costs one regex over a string
// that was fetched anyway.
//
// Driven by the real Mercedes-Benz E-Class (W213) and G-Class infoboxes, which
// between them contain every trap: nearly every link in an engine field ends
// in the word "engine" and nearly none of them is one.
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
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

const W213 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_E-Class__W213_.wikitext"), "utf-8");
const GCLASS = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_G-Class.wikitext"), "utf-8");
const GOLF = fs.readFileSync(path.join(CACHE, "Volkswagen_Golf.wikitext"), "utf-8");

// ---------- 1. telling an engine from the words around it ----------
{
  const yes = ["Mercedes-Benz M256 engine", "Mercedes-Benz OM654 engine",
               "Mercedes-Benz M260/M264 engine", "Mercedes-Benz M256 engine#M256 E30"];
  const no = ["Petrol engine", "Diesel engine", "Hybrid engine", "Straight-six engine",
              "Straight-four engine", "V6 engine", "V8 engine", "Flat-four engine",
              "Turbocharger", "Mercedes-AMG", "mild hybrid"];
  check("a real engine article is recognised by its code",
        yes.every(t => LF.looksLikeEngineArticleTitle(t)),
        yes.filter(t => !LF.looksLikeEngineArticleTitle(t)).join(", "));
  check("the fuel and the layout are not engines, though they are all named "
        + "'... engine'", no.every(t => !LF.looksLikeEngineArticleTitle(t)),
        no.filter(t => LF.looksLikeEngineArticleTitle(t)).join(", "));
}

// ---------- 2. what the W213 actually ran ----------
{
  const m = LF.engineMentions(W213);
  const names = m.map(x => x.name);
  // Eleven entries, nine distinct engines: the W213 runs two different M264
  // variants (E15 and E20) and two different M274s (DE16 and DE20), and those
  // are four different engines, not two. They were collapsed to one apiece
  // while this read the field as a flat bag of links with no idea which line
  // each came from -- so the 1.5 and the 2.0 were the same thing.
  check("the W213's engines are found", m.length === 12, names.join(", "));
  // The twelfth is "2.0 L ''M270'' plug-in hybrid turbo I4" -- named without
  // a link, because the line above it linked the same engine. See
  // engineFieldEntries.
  check("...including the one named without a link of its own",
        m.some(x => x.name === "M270" && /plug-in hybrid/.test(x.said)),
        JSON.stringify(m.filter(x => x.name === "M270").map(x => x.said)));
  check("...one entry per line of the infobox, so two variants of one engine are two",
        m.filter(x => x.name === "M264").length === 2 &&
        m.filter(x => x.name === "M264").map(x => x.variant).join("|") ===
          "M264 E15 DEH LA|M264 E20 DEH LA",
        m.filter(x => x.name === "M264").map(x => x.variant).join(" | "));
  check("...each carrying what its own line said about it",
        m.filter(x => x.name === "M264").map(x => x.specs.displacement).join("|") === "1.5 L|2.0 L",
        JSON.stringify(m.filter(x => x.name === "M264").map(x => x.specs)));
  check("...and the fuel heading it sits under",
        (m.find(x => x.name === "OM654") || {}).specs.fuel === "diesel" &&
        (m.find(x => x.name === "M256") || {}).specs.fuel === "petrol",
        JSON.stringify([(m.find(x => x.name === "OM654") || {}).specs,
                        (m.find(x => x.name === "M256") || {}).specs]));
  check("...with the layout it names",
        (m.find(x => x.name === "M256") || {}).specs.layout === "I" &&
        (m.find(x => x.name === "M256") || {}).specs.cylinders === 6,
        JSON.stringify((m.find(x => x.name === "M256") || {}).specs));
  check("...including the M256 this whole layer started from",
        names.indexOf("M256") >= 0, names.join(", "));
  check("...and its diesels", names.indexOf("OM654") >= 0 && names.indexOf("OM656") >= 0);
  check("none of the fuel or layout links came along",
        !m.some(x => /Petrol|Diesel engine|Straight|^V\d/.test(x.title)), m.map(x => x.title).join(" | "));

  // An anchor names the specific variant, which is worth keeping even though
  // nothing follows it yet.
  const m264 = m.find(x => x.name === "M264");
  check("a link into a variant keeps which variant it was",
        m264 && m264.variant === "M264 E15 DEH LA", m264 && m264.variant);
  check("...while the node it will become is the whole article",
        m264 && m264.title === "Mercedes-Benz M260/M264 engine", m264 && m264.title);

  // Every generation's infobox, not just the first.
  check("a single-article nameplate is read across all its infoboxes",
        LF.engineMentions(GCLASS).length > 20, LF.engineMentions(GCLASS).length);
  check("a car whose infobox names no engine yields none, rather than guessing",
        LF.engineMentions(GOLF).length === 0, LF.engineMentions(GOLF).length);
}

// ---------- 3. one node, however the engine was reached ----------
{
  check("a mention and the engine's own infobox name land on the same id",
        LF.engineIdFromTitle("Mercedes-Benz M256 engine") === LF.engineIdFromTitle("Mercedes-Benz M256"),
        LF.engineIdFromTitle("Mercedes-Benz M256 engine"));
}

// ---------- 4. into the graph, unresearched ----------
{
  const car = DATA.nodes.find(n => n.type === "model" && !n.familyOf) ||
              DATA.nodes.find(n => n.type === "model");
  const nodesBefore = DATA.nodes.length;
  const r = LF.recordEngineMentions(W213, car, DATA.nodes, DATA.links);
  check("nine engine nodes appear", r.engines === 9, r.engines);
  check("...connected to the car that named them", r.fitted === 9, r.fitted);
  const eng = DATA.nodes.find(n => n.type === "engine" && n.label === "M256");
  check("...and each is marked unresearched, because nothing read its article",
        !!eng && eng.unresearched === true, eng && JSON.stringify(eng.unresearched));
  check("...with no variants, for the same reason",
        !!eng && (eng.variants || []).length === 0);

  const again = LF.recordEngineMentions(W213, car, DATA.nodes, DATA.links);
  check("recording the same car twice adds nothing", again.engines === 0 && again.fitted === 0,
        again.engines + "/" + again.fitted);

  // The promise that the main graph is untouched, checked at the point where
  // it would break: buildSim deletes links whose endpoints it cannot resolve,
  // and simulates every node it is given.
  check("none of it shows up in the main graph",
        DATA.nodes.filter(n => cw.nodeInLayer(n) && n.type === "engine").length === 0);
  const fittedBefore = DATA.links.filter(l => l.type === "fitted").length;
  cw.rebuildSim();
  check("...and rebuilding the simulation does not delete the engine's edges",
        DATA.links.filter(l => l.type === "fitted").length === fittedBefore,
        DATA.links.filter(l => l.type === "fitted").length + " of " + fittedBefore);
  check("...nor the engines themselves", DATA.nodes.length === nodesBefore + 9,
        DATA.nodes.length - nodesBefore);
  check("the simulation is not laying out invisible engines",
        cw.sim().nodes().every(n => n.type !== "engine" && n.type !== "enginevar"));
}

// ---------- 5. a scanned engine takes over the same node ----------
{
  const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");
  const article = LF.readEngineArticle(M256, "Mercedes-Benz M256 engine");
  const before = DATA.nodes.filter(n => n.type === "engine").length;
  const r = LF.applyEngineArticleWith(article, "Mercedes-Benz M256 engine",
                                      DATA.nodes, DATA.links, new Map(), {});
  check("no second M256 node is created for the one already mentioned",
        DATA.nodes.filter(n => n.type === "engine").length === before, before);
  check("...it is the same node, now with its variants", r.variants === 3, r.variants);
  check("...and its spec card filled in",
        r.engine.configuration === "Straight-six", r.engine.configuration);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
