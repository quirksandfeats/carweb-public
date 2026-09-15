// Two things an engine has to do once it is in the graph.
//
// The cascade. "For all of the cars listed there... it should also
// automatically do an LLM check on whichever car is connected to this engine,
// as if it's doing an LLM check on the car as well. Once again, it should use
// the cascade matching that within serve.py so that it doesn't get out of
// control." The engine is depth 0; the cars it names are depth 1 and get the
// ordinary check; THEIR partners and engines are depth 2 and stop.
//
// The merge. "It is also possible in this step to merge some of the engines
// together, if they are all M256 but some are older generations than other...
// like a nameplate (remember this functionality should work the same as for
// regular nameplates)." Same shape, deliberately different code -- see
// applyOneEngineMerge for why applyOneMerge could not be reused.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");

// A tiny engine article naming two cars: one already in the graph as an
// ungrouped plain model, one that has to be created.
const T9 = [
  "{{Infobox automobile engine",
  "| name = TestCo T9",
  "| manufacturer = [[TestCo]]",
  "| production = 2000-2020",
  "}}",
  "The '''T9'''.",
  "=== T9 A ===",
  "* 2000-2010 [[TestCo Alpha|Alpha 20]]",
  "* 2005-2012 [[TestCo Beta|Beta 20]]",
].join("\n");

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

const ARTICLES = {
  "TestCo T9": T9,
  "Mercedes-Benz M256 engine": M256,
  "TestCo Alpha": "{{Infobox automobile|name=TestCo Alpha}}\n" +
    "== First generation (A1; 2000) ==\nThe A1.\n== Second generation (A2; 2006) ==\nThe A2.\n",
  "TestCo Beta": "{{Infobox automobile|name=TestCo Beta}}\nA one-generation car.\n",
};
const asked = [];
const llmFor = [];
window.fetch = (url, opts) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    asked.push(title);
    const wt = ARTICLES[title];
    if (!wt) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    const txt = JSON.stringify(JSON.parse(opts.body).messages);
    llmFor.push(/Alpha/.test(txt) ? "Alpha" : /Beta/.test(txt) ? "Beta" : "other");
    if (/Alpha/.test(txt)) {
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: true,
        generations: [
          { code: "A1", yearStart: 2000, yearEnd: 2006, designers: [], engineers: [], sharedPlatforms: [] },
          { code: "A2", yearStart: 2006, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] },
        ] }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      hasMultipleGenerations: false, generations: [] }) } }] }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
// Seeded BEFORE app.js, because app.js builds its byId index the moment it is
// evaluated -- a node pushed afterwards is in the array and in no index.
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const MK = { id: "mk-testco", type: "make", label: "TestCo", year: 1950 };
    D.nodes.push(MK);
    ["Alpha", "Beta"].forEach(lbl => {
      D.nodes.push({ id: "m-testco-" + lbl.toLowerCase(), type: "model", label: lbl, make: "TestCo",
                     wp: "TestCo " + lbl, year: 2000, end: null, designers: [], engineers: [] });
      D.links.push({ source: "m-testco-" + lbl.toLowerCase(), target: MK.id, type: "made" });
    });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const DATA = window.CARDATA;
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;

(async () => {
  // ---------- 1. the cascade ----------
  {
    check("(precondition) Alpha is an ungrouped plain model",
          cw.byId.get("m-testco-alpha").type === "model" && !cw.byId.get("m-testco-alpha").familyOf);
    check("(precondition) nothing has been asked of the model yet", llmFor.length === 0);

    cw.setLlmCheck(true);
    cw.scanEngine("TestCo T9", null);
    for (let i = 0; i < 200 && cw.byId.get("m-testco-alpha").type !== "family"; i++) await sleep(25);

    check("the engine was read", !!DATA.nodes.find(n => n.type === "engine" && /T9/.test(n.label)));
    check("...and the cars it names were checked, without being clicked",
          llmFor.indexOf("Alpha") >= 0, llmFor.join(", "));
    check("...so a car that hid generations became a nameplate on its own",
          cw.byId.get("m-testco-alpha").type === "family",
          cw.byId.get("m-testco-alpha").type);
    check("...with the generations the check found",
          (cw.byId.get("m-testco-alpha").generations || []).length === 2,
          (cw.byId.get("m-testco-alpha").generations || []).length);
    check("a car that hides none is left alone, not forced into a nameplate",
          cw.byId.get("m-testco-beta").type === "model", cw.byId.get("m-testco-beta").type);

    // Where it stops. Alpha is depth 1, so its OWN partners and engines are
    // depth 2 and must not be followed.
    check("the budget is the one serve.py sets", LF.cascadeMaxDepth() === 1, LF.cascadeMaxDepth());
    check("...and a car reached through the engine sits at depth 1",
          LF.cascadeDepthOf("m-testco-alpha") === 1, LF.cascadeDepthOf("m-testco-alpha"));
    check("nothing at depth 2 was fetched",
          !asked.some(t => /M256/.test(t)), asked.join(", "));
  }

  // ---------- 2. merging ----------
  {
    // The real case: an engine known only as a name on a car's infobox, and
    // the same family properly read. Two nodes, one engine.
    const car = cw.byId.get("m-testco-beta");
    LF.recordEngineMentionsFrom(
      [{ title: "Mercedes-Benz M256 engine", name: "M256", variant: null }], car, DATA.nodes, DATA.links);
    const mentioned = DATA.nodes.find(n => n.type === "engine" && n.label === "M256");
    const t9 = DATA.nodes.find(n => n.type === "engine" && /T9/.test(n.label));
    check("(precondition) two separate engines exist", !!mentioned && !!t9 && mentioned !== t9);
    check("(precondition) the mentioned one has no variants of its own",
          (mentioned.variants || []).length === 0);
    const t9VarsBefore = (t9.variants || []).length;
    const fittedToMentioned = DATA.links.filter(l => l.type === "fitted" && l.source === mentioned.id).length;
    check("(precondition) ...but it IS fitted to something", fittedToMentioned > 0, fittedToMentioned);

    const r = LF.mergeEngines(t9.id, [mentioned.id], DATA.nodes, DATA.links);
    check("the merge succeeds", r.ok === true, r.error);
    check("the husk is retired, not deleted", mentioned.retired === true &&
          DATA.nodes.indexOf(mentioned) >= 0);
    check("...and says what it was merged into", mentioned.supersededBy === t9.id, mentioned.supersededBy);
    check("an engine with no variants of its own becomes one",
          (t9.variants || []).length === t9VarsBefore + 1,
          t9VarsBefore + " -> " + (t9.variants || []).length);
    // Looked up in the node ARRAY: mergeEngines is the machinery, and
    // indexing is the caller's job (mergeEnginePrompt does it).
    const nodeById = id => DATA.nodes.find(n => n.id === id);
    const newVar = (t9.variants || []).map(nodeById).find(v => v && v.label === "M256");
    check("...keeping its name", !!newVar, (t9.variants || []).join(", "));
    check("...and everything it was fitted to came with it",
          DATA.links.some(l => l.type === "fitted" && l.source === newVar.id),
          DATA.links.filter(l => l.type === "fitted" && l.source === newVar.id).length);
    check("nothing is still hanging off the husk",
          DATA.links.filter(l => l.type === "fitted" && !l.retired && l.source === mentioned.id).length === 0);

    // Merging an engine that HAS variants moves those instead.
    const other = { id: "eng-test-other", type: "engine", label: "T7", variants: [] };
    const ov = { id: "engv-test-other-t7a", type: "enginevar", label: "T7 A", engineOf: other.id };
    other.variants.push(ov.id);
    DATA.nodes.push(other, ov);
    DATA.links.push({ source: other.id, target: ov.id, type: "enginegen" });
    const before = (t9.variants || []).length;
    const r2 = LF.mergeEngines(t9.id, [other.id], DATA.nodes, DATA.links);
    check("merging an engine that HAS variants brings those over", r2.ok &&
          (t9.variants || []).length === before + 1, before + " -> " + (t9.variants || []).length);
    check("...re-parented rather than copied", ov.engineOf === t9.id && DATA.nodes.filter(n => n.id === ov.id).length === 1,
          ov.engineOf);

    // Recorded and replayable, like every other decision here.
    const rec = LF.allEngineMerges().find(m => m.id === t9.id);
    check("the merge is recorded", !!rec);
    // Both of them. A second merge into the same primary that REPLACED the
    // record would look right all session and come back un-merged after a
    // reload, which is the worst shape a bug can have.
    check("...including both engines folded in, not just the last one",
          rec && rec.memberIds.length === 2, rec && rec.memberIds.join(", "));
    const varsBefore = (t9.variants || []).slice();
    LF.applyEngineMerges(DATA.nodes, DATA.links);
    check("replaying it over an already-merged graph changes nothing",
          (t9.variants || []).join(",") === varsBefore.join(","),
          (t9.variants || []).join(", "));
    check("...and leaves no duplicate variants",
          (t9.variants || []).length === new Set(t9.variants).size,
          (t9.variants || []).join(", "));

    await LF.undoEngineMerge(t9.id);
    check("undoing it removes the record", !LF.allEngineMerges().some(m => m.id === t9.id));
  }

  // ---------- 3. the card offers both ----------
  {
    const t9 = DATA.nodes.find(n => n.type === "engine" && /T9/.test(n.label));
    cw.openDetail(t9);
    const labels = [...window.document.querySelectorAll(".dt-power button")].map(b => b.textContent);
    check("an engine's card offers to merge another in",
          labels.some(t => /Merge another engine in/.test(t)), labels.join(" | ").slice(0, 120));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
