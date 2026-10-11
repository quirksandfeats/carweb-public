// Six reports from one review (2026-10-11):
//   1. the Mercedes SL R232 showed two identical "M177" engines: two variant
//      nodes of one engine with one name are folded into one;
//   2. a car on an engine variant is not also connected to the engine family;
//   3. re-reading an engine does not simply drop a car the new reading no
//      longer lists -- the car's own article is checked first;
//   4. a nameplate succession lands on the generations whose years meet
//      (the Fifth Avenue was followed by the 1990 Imperial, not the 1926 one);
//   5. a load that changes nothing writes nothing, and its notes go in one
//      request.
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
  return new Proxy({ measureText: () => ({ width: 10 }) }, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
const idOf = v => (v && v.id) || v;

function boot({ nodes = [], links = [], store = {}, pages = {} }) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  const posts = { store: [], notes: [] };
  window.fetch = (u, o) => {
    const s = String(u);
    if (o && o.method === "POST" && s === "/api/llm-families") posts.store.push(o.body);
    if (o && o.method === "POST" && s === "/api/note") posts.notes.push(JSON.parse(o.body));
    const m = s.match(/[?&]page=([^&]+)/);
    if (m) {
      const title = decodeURIComponent(m[1]).replace(/\+/g, " ").replace(/_/g, " ");
      const wt = pages[title];
      if (wt == null) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js"); load("data.js");
  nodes.forEach(n => window.CARDATA.nodes.push(JSON.parse(JSON.stringify(n))));
  links.forEach(l => window.CARDATA.links.push(JSON.parse(JSON.stringify(l))));
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {} }, JSON.parse(JSON.stringify(store)),
    { __serverAvailable: true, __config: { cascadeMaxDepth: 1 } });
  load("llm_families.js"); load("app.js"); load("timeline.js"); load("sixdeg.js");
  window.CarWeb.boot();
  return { window, cw: window.CarWeb, LF: window.LlmFamilies, posts };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = (id, label, make, year, end, extra) => Object.assign({ id, type: "model", label, make, year, end, designers: [], engineers: [] }, extra || {});

(async () => {
  // ---------- 1 and 2: one variant per name, no family line beside it ----------
  {
    const { LF } = boot({});
    const nodes = [
      { id: "e-fam", type: "engine", label: "M176/M177/M178", variants: ["v-a", "v-b"] },
      { id: "v-a", type: "enginevar", label: "M177", engineOf: "e-fam" },
      { id: "v-b", type: "enginevar", label: "M177", engineOf: "e-fam", fromMergedEngine: "e-m177" },
      mk("c-sl", "SL R232", "Tst", 2022, null), mk("c-gls", "GLS", "Tst", 2019, null), mk("c-db12", "DB12", "Tst", 2023, null),
    ];
    const links = [
      { source: "v-a", target: "c-sl", type: "fitted" }, { source: "v-b", target: "c-sl", type: "fitted" },
      { source: "v-a", target: "c-gls", type: "fitted" },
      { source: "v-b", target: "c-db12", type: "fitted" }, { source: "e-fam", target: "c-db12", type: "fitted" },
    ];
    const r = LF.tidyEngineLinks(nodes, links);
    const fit = car => links.filter(l => l.type === "fitted" && (idOf(l.target) === car || idOf(l.source) === car));
    check("two variants of one engine with one name become one", r.folded === 1 && nodes.find(n => n.id === "v-b").retired, JSON.stringify(r));
    check("...and the SL R232 lists the M177 once", fit("c-sl").length === 1 && idOf(fit("c-sl")[0].source) === "v-a",
      JSON.stringify(fit("c-sl").map(l => idOf(l.source))));
    check("...the other's cars move to the one kept", fit("c-db12").some(l => idOf(l.source) === "v-a"));
    check("a car on a variant is not also on the engine family", !fit("c-db12").some(l => idOf(l.source) === "e-fam") && r.dropped === 1,
      JSON.stringify(fit("c-db12").map(l => idOf(l.source))));
  }

  // ---------- 3: a re-read checks before it forgets ----------
  {
    const ENG = "{{Infobox engine\n| name = TstEng X1\n| manufacturer = Tst\n| production = 2001–2010\n| configuration = Straight-4\n}}\n" +
      "The '''TstEng X1''' is a straight-four engine.\n\n== Applications ==\n";
    const first = ENG + "* [[Tst Alpha]]\n* [[Tst Beta]]\n* [[Tst Gamma]]\n";
    const second = ENG + "* [[Tst Alpha]]\n";
    const pages = {
      "TstEng X1 engine": first,
      "Tst Beta": "{{Infobox automobile\n| name = Tst Beta\n}}\nThe Beta used the X1 engine until 2008.",
      "Tst Gamma": "{{Infobox automobile\n| name = Tst Gamma\n}}\nThe Gamma had a diesel.",
    };
    const nodes = [{ id: "mk-tst", type: "make", label: "Tst", year: 1950 },
      mk("c-alpha", "Alpha", "Tst", 2001, 2006, { wp: "Tst Alpha" }), mk("c-beta", "Beta", "Tst", 2002, 2008, { wp: "Tst Beta" }),
      mk("c-gamma", "Gamma", "Tst", 2003, 2009, { wp: "Tst Gamma" })];
    const links = nodes.slice(1).map(n => ({ source: n.id, target: "mk-tst", type: "made" }));
    const { cw, LF, window } = boot({ nodes, links, pages });
    const D = window.CARDATA;
    const r1 = await LF.checkEngine("TstEng X1 engine", D.nodes, D.links, { cascade: false, mintCars: false });
    check("(precondition) the first reading connects three cars", r1.status === "confirmed" && r1.cars && r1.cars.length === 3,
      JSON.stringify({ s: r1.status, cars: (r1.cars || []).map(c => c.id) }));
    pages["TstEng X1 engine"] = second;
    const r2 = await LF.forceRecheckEngine("TstEng X1 engine", D.nodes, D.links, { cascade: false, mintCars: false, id: r1.id });
    const entry = LF.engineEntryFor(r1.id);
    const kept = (entry && entry.kept) || [];
    check("a car the new reading drops, whose own article names the engine, is kept", kept.some(k => k.car === "c-beta"),
      JSON.stringify(kept));
    check("...one whose article does not name it is let go", !kept.some(k => k.car === "c-gamma"));
    // and the kept one is drawn on every load
    const { window: w2 } = boot({ nodes, links, pages, store: { engines: { [r1.id]: entry } } });
    const fitted = w2.CarWeb.links.filter(l => l.type === "fitted").map(l => [idOf(l.source), idOf(l.target)].join(">"));
    check("...and the kept car is connected after a reload", fitted.some(x => x.endsWith("c-beta")) && !fitted.some(x => x.endsWith("c-gamma")),
      JSON.stringify(fitted));
  }

  // ---------- 4: succession lands where the years meet ----------
  {
    const nodes = [
      { id: "f-fa", type: "family", label: "Fifth Avenue", make: "Tsc", year: 1979, end: 1993, generations: ["g-fa-r", "g-fa-m"] },
      mk("g-fa-r", "Fifth Avenue R-body", "Tsc", 1979, 1981, { familyOf: "f-fa" }),
      mk("g-fa-m", "Fifth Avenue M-body", "Tsc", 1982, 1989, { familyOf: "f-fa" }),
      { id: "f-imp", type: "family", label: "Imperial", make: "Tsc", year: 1926, end: 1993, generations: ["g-imp-1", "g-imp-7"] },
      mk("g-imp-1", "Imperial Series E 80", "Tsc", 1926, 1930, { familyOf: "f-imp" }),
      mk("g-imp-7", "Imperial Seventh generation", "Tsc", 1990, 1993, { familyOf: "f-imp" }),
    ];
    const links = [{ source: "f-fa", target: "f-imp", type: "succession" },
      { source: "f-fa", target: "g-fa-r", type: "generation" }, { source: "f-fa", target: "g-fa-m", type: "generation" },
      { source: "f-imp", target: "g-imp-1", type: "generation" }, { source: "f-imp", target: "g-imp-7", type: "generation" }];
    const { cw } = boot({ nodes, links });
    const derived = cw.links.filter(l => l.type === "succession" && l.genLevel && [idOf(l.source), idOf(l.target)].some(x => /g-(fa|imp)/.test(x)))
      .map(l => idOf(l.source) + ">" + idOf(l.target));
    check("the Fifth Avenue hands over to the 1990 Imperial, not the 1926 one", derived.includes("g-fa-m>g-imp-7") && !derived.some(x => x.endsWith("g-imp-1")),
      JSON.stringify(derived));
  }

  // ---------- 5: a load that changes nothing writes nothing ----------
  {
    const store = { relations: {}, recheck: {} };
    const { posts } = boot({ store });
    await sleep(600);
    check("a load with nothing new does not rewrite the store", posts.store.length === 0, posts.store.length);
    check("notes go in one request, not one each", posts.notes.length <= 1 && (!posts.notes[0] || Array.isArray(posts.notes[0].lines)),
      JSON.stringify(posts.notes.map(n => (n.lines || []).length)));
  }

  // ---------- 6: two nameplates for one article ----------
  {
    const nodes = [
      { id: "mk-tsb", type: "make", label: "Tsb", year: 1900 },
      { id: "fam-tsb-b", type: "family", label: "B", make: "Tsb", year: 2005, end: null, generations: ["m-tsb-bclass", "m-tsb-w246"] },
      mk("m-tsb-bclass", "B-Class", "Tsb", 2005, null, { familyOf: "fam-tsb-b", wp: "Tsb B-Class" }),
      mk("m-tsb-w246", "B-Class (W246)", "Tsb", 2011, 2018, { familyOf: "fam-tsb-b", wp: "Tsb B-Class (W246)" }),
      { id: "llm-fam-b2", type: "family", label: "B-Class", make: "Tsb", year: 2005, end: null, llmGenerated: true, wp: "Tsb B-Class",
        generations: ["g-b2-w245", "g-b2-w246", "g-b2-w247"] },
      mk("g-b2-w245", "B-Class W245", "Tsb", 2005, 2011, { familyOf: "llm-fam-b2" }),
      mk("g-b2-w246", "B-Class W246", "Tsb", 2011, 2018, { familyOf: "llm-fam-b2" }),
      mk("g-b2-w247", "B-Class W247", "Tsb", 2018, null, { familyOf: "llm-fam-b2" }),
    ];
    const links = [{ source: "fam-tsb-b", target: "m-tsb-bclass", type: "generation" }, { source: "fam-tsb-b", target: "m-tsb-w246", type: "generation" },
      { source: "llm-fam-b2", target: "g-b2-w245", type: "generation" }, { source: "llm-fam-b2", target: "g-b2-w246", type: "generation" },
      { source: "llm-fam-b2", target: "g-b2-w247", type: "generation" }].concat(
      ["fam-tsb-b", "llm-fam-b2"].map(id => ({ source: id, target: "mk-tsb", type: "made" })));
    const { cw } = boot({ nodes, links });
    const B = cw.byId.get("fam-tsb-b");
    check("the build's nameplate on the same article gives way to the split one", B.retired && B.supersededBy === "llm-fam-b2", B.retired + " " + B.supersededBy);
    check("...its overview member folds into the nameplate, its W246 into the W246", cw.byId.get("m-tsb-bclass").supersededBy === "llm-fam-b2" &&
      cw.byId.get("m-tsb-w246").supersededBy === "g-b2-w246", cw.byId.get("m-tsb-w246").supersededBy);
  }
  // ---------- 7: a rename that already fits ----------
  {
    const nodes = [{ id: "mk-tsr", type: "make", label: "Tsr", year: 1900 },
      { id: "fam-tsr-b", type: "family", label: "B", make: "Tsr", year: 2005, end: null, generations: ["m-tsr-w246"] },
      mk("m-tsr-w246", "B-Class (W246)", "Tsr", 2011, 2018, { familyOf: "fam-tsr-b" })];
    const links = [{ source: "fam-tsr-b", target: "m-tsr-w246", type: "generation" }, { source: "fam-tsr-b", target: "mk-tsr", type: "made" }];
    const { cw } = boot({ nodes, links, store: { renames: { "fam-tsr-b": { label: "B-Class", previousLabel: "B", kind: "family" } } } });
    check("renaming \"B\" to \"B-Class\" leaves \"B-Class (W246)\" as it is", cw.byId.get("m-tsr-w246").label === "B-Class (W246)", cw.byId.get("m-tsr-w246").label);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
