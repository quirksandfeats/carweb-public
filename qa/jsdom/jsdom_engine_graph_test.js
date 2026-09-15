// Putting a real engine into the graph, and the one rule the user was most
// specific about:
//
//   "specify to the nameplate's generation. Fallback is to specify to the
//    nameplate itself, but don't do both. For example, if m256 appears in e
//    class, w213, and w214, then only have it connect to w213 and w214. So
//    long as one generation is mentioned, never connect the engine to the
//    main nameplate but only the gen."
//
// The trap is that the rule is per NAMEPLATE while the article speaks in
// titles, and one nameplate gets several. The real M256 page links the GLE as
// "Mercedes GLE#Fourth generation (W167/C167; 2018)", as "Mercedes-Benz
// M-Class" and as "Mercedes-Benz GLE-Class" -- three titles, two of them
// redirects left over from renames. Grouping on the titles would hang the
// engine off the nameplate AND a generation at once, which is the thing that
// was asked against; grouping on the node each title RESOLVES to is what
// makes it come out right.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.resolve(__dirname, "..", "..", "app");
const CACHE = path.resolve(__dirname, "..", "wiki_cache");
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
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
ev("llm_families.js");
const LF = window.LlmFamilies;

const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");

// Wikipedia's own redirects, as they really are for these titles.
const REDIRECTS = {
  "Mercedes-Benz M-Class": "Mercedes-Benz GLE-Class",
  "Mercedes GLE": "Mercedes-Benz GLE-Class",
};
const resolve = async t => REDIRECTS[t] || t;

// A small graph shaped like the real one where it matters: the E-Class split
// into W213/W214, the S-Class split into W222/W223, and the CLE and GLE left
// as whole nameplates that were never split.
function graph() {
  const nodes = [], links = [];
  const mk = { id: "mk-mercedes-benz", type: "make", label: "Mercedes-Benz", year: 1926 };
  nodes.push(mk);
  const fam = (id, label, wp, gens) => {
    const f = { id, type: "family", label, make: "Mercedes-Benz", wp, generations: [], designers: [], engineers: [] };
    nodes.push(f);
    links.push({ source: id, target: mk.id, type: "made" });
    gens.forEach(([gid, glabel, gwp]) => {
      const g = { id: gid, type: "model", label: glabel, make: "Mercedes-Benz", wp: gwp, familyOf: id,
                  designers: [], engineers: [] };
      nodes.push(g); f.generations.push(gid);
      links.push({ source: id, target: gid, type: "generation" });
    });
    return f;
  };
  const model = (id, label, wp) => {
    const m = { id, type: "model", label, make: "Mercedes-Benz", wp, designers: [], engineers: [] };
    nodes.push(m);
    links.push({ source: id, target: mk.id, type: "made" });
    return m;
  };
  fam("fam-mb-e-class", "E-Class", "Mercedes-Benz E-Class", [
    ["m-mb-e-w213", "E-Class (W213)", "Mercedes-Benz E-Class (W213)"],
    ["m-mb-e-w214", "E-Class (W214)", "Mercedes-Benz E-Class (W214)"],
  ]);
  fam("fam-mb-s-class", "S-Class", "Mercedes-Benz S-Class", [
    ["m-mb-s-w222", "S-Class (W222)", "Mercedes-Benz S-Class (W222)"],
    ["m-mb-s-w223", "S-Class (W223)", "Mercedes-Benz S-Class (W223)"],
  ]);
  model("m-mb-cle", "CLE", "Mercedes-Benz CLE");
  model("m-mb-gle-class", "GLE-Class", "Mercedes-Benz GLE-Class");
  model("m-mb-cls-c257", "CLS-Class (C257)", "Mercedes-Benz CLS-Class (C257)");
  model("m-mb-gls-x167", "GLS-Class (X167)", "Mercedes-Benz GLS-Class (X167)");
  model("m-mb-amg-gt4", "AMG GT 4-Door Coupé", "Mercedes-AMG GT 4-Door Coupé");
  model("m-am-dbx", "DBX", "Aston Martin DBX");
  return { nodes, links };
}

(async () => {
  const article = LF.readEngineArticle(M256, "M256");

  // ---------- 1. the nameplate/generation rule ----------
  {
    const { nodes, links } = graph();
    const r = await LF.applyEngineArticle(article, "Mercedes-Benz M256 engine", nodes, links, { resolve });
    const fitted = links.filter(l => l.type === "fitted");
    const to = id => fitted.filter(l => l.target === id || l.source === id).length;

    check("the E-Class is reached at generation level", to("m-mb-e-w213") > 0 && to("m-mb-e-w214") > 0,
          "W213:" + to("m-mb-e-w213") + " W214:" + to("m-mb-e-w214"));
    check("...and never at nameplate level, because a generation was named",
          to("fam-mb-e-class") === 0, to("fam-mb-e-class"));
    check("the S-Class likewise", to("m-mb-s-w222") > 0 && to("m-mb-s-w223") > 0 && to("fam-mb-s-class") === 0,
          "W222:" + to("m-mb-s-w222") + " W223:" + to("m-mb-s-w223") + " fam:" + to("fam-mb-s-class"));
    check("the CLE, which the article names only as a whole nameplate, is "
          + "reached anyway", to("m-mb-cle") > 0, to("m-mb-cle"));

    // The three-titles-one-car case. Three of the M256's variants went into a
    // GLE, and the article links it under a different title each time --
    // "Mercedes GLE#Fourth generation", "Mercedes-Benz M-Class",
    // "Mercedes-Benz GLE-Class". Three real facts, one car.
    check("every title that means the GLE lands on the same car",
          to("m-mb-gle-class") === 3, to("m-mb-gle-class"));
    check("...and no second GLE node was invented for the old titles",
          nodes.filter(n => /GLE|M-Class/i.test(n.label || "")).length === 1,
          nodes.filter(n => /GLE|M-Class/i.test(n.label || "")).map(n => n.label).join(", "));

    // One variant that went into the same car twice (two trims of the W223)
    // is one edge, not two.
    const gr = nodes.find(n => n.type === "enginevar" && /E30 DEH LA GR/.test(n.label));
    check("two trims of one car under one variant are one connection",
          fitted.filter(l => l.source === gr.id && l.target === "m-mb-s-w223").length === 1,
          fitted.filter(l => l.source === gr.id && l.target === "m-mb-s-w223").length);
  }

  // ---------- 1b. the rule spans the whole engine, not one variant ----------
  // The M256 never does this, but an engine whose first variant names a
  // nameplate and whose second names one of its generations would, grouped
  // per variant, end up attached at both levels at once.
  {
    const src = [
      "{{Infobox automobile engine",
      "| name = Test T9",
      "| production = 2000-2020",
      "}}",
      "The '''T9'''.",
      "=== T9 A ===",
      "* 2000-2010 [[Mercedes-Benz E-Class|E 200]]",
      "=== T9 B ===",
      "* 2016-2020 [[Mercedes-Benz E-Class (W213)|W213 E 300]]",
    ].join("\n");
    const mixed = LF.readEngineArticle(src, "T9");
    const { nodes, links } = graph();
    await LF.applyEngineArticle(mixed, "Test T9", nodes, links, { resolve });
    const fitted = links.filter(l => l.type === "fitted");
    const shown = fitted.map(l => l.source + "->" + l.target).join(" | ");
    check("a generation named by ANY variant suppresses the nameplate edge "
          + "from every other one", !fitted.some(l => l.target === "fam-mb-e-class"), shown);
    check("...and the generation edge survives", fitted.some(l => l.target === "m-mb-e-w213"), shown);
  }

  // ---------- 2. the engine itself ----------
  {
    const { nodes, links } = graph();
    const r = await LF.applyEngineArticle(article, "Mercedes-Benz M256 engine", nodes, links, { resolve });
    const eng = nodes.find(n => n.type === "engine");
    check("an engine node exists", !!eng && eng.label === "Mercedes-Benz M256", eng && eng.label);
    check("...carrying its spec card", eng.configuration === "Straight-six" && /2498/.test(eng.displacement || ""),
          eng.configuration + " / " + eng.displacement);
    check("...and the year it entered production", eng.year === 2017, eng.year);
    check("its three variants are nodes too", r.variants === 3, r.variants);
    const vars = nodes.filter(n => n.type === "enginevar");
    check("...each pointing back at the engine", vars.every(v => v.engineOf === eng.id));
    check("...and listed on it", (eng.variants || []).length === 3, (eng.variants || []).join(", "));
    check("the engine links to each variant",
          links.filter(l => l.type === "enginegen").length === 3);
    check("...and the variants run in succession, like generations do",
          links.filter(l => l.type === "enginesucc").length === 2);
    check("a fitted edge carries the years the article gave",
          links.some(l => l.type === "fitted" && l.yearStart === 2017 && l.yearEnd === 2020));
    check("...and a 'China only' note where there was one",
          links.some(l => l.type === "fitted" && /China only/.test(l.note || "")));
  }

  // ---------- 3. the car that isn't in the graph ----------
  {
    const { nodes, links } = graph();
    const before = nodes.length;
    await LF.applyEngineArticle(article, "Mercedes-Benz M256 engine", nodes, links, { resolve });
    check("without permission, a missing car is not invented", nodes.length === before + 4,
          (nodes.length - before) + " new nodes (engine + 3 variants)");
    check("...and the engine is not hung off the Austro-Daimler COMPANY article",
          !nodes.some(n => n.type === "make" && /Austro/i.test(n.label)));

    const g2 = graph();
    await LF.applyEngineArticle(article, "Mercedes-Benz M256 engine", g2.nodes, g2.links,
                                { resolve, mintCars: true });
    const berg = g2.nodes.find(n => /Bergmeister/i.test(n.label || ""));
    check("with permission, it is created from the display text -- the only "
          + "place its name exists", !!berg, berg && (berg.make + " / " + berg.label));
    check("...as a car, not a marque", berg && berg.type === "model", berg && berg.type);
    // Splitting the display text on its first space made this an "Austro"
    // called "Daimler Bergmeister PHEV". The link target is what says where
    // the marque really ends.
    check("...under the marque the LINK names, not the first word of the text",
          berg && berg.make === "Austro-Daimler" && /^Bergmeister/.test(berg.label),
          berg && (berg.make + " / " + berg.label));
    check("...and the engine is wired to it",
          g2.links.some(l => l.type === "fitted" && (l.target === berg.id || l.source === berg.id)));
  }

  // ---------- 4. running it again changes nothing ----------
  {
    const { nodes, links } = graph();
    await LF.applyEngineArticle(article, "Mercedes-Benz M256 engine", nodes, links, { resolve });
    const n1 = nodes.length, l1 = links.length;
    const r2 = await LF.applyEngineArticle(article, "Mercedes-Benz M256 engine", nodes, links, { resolve });
    check("a second pass adds no nodes", nodes.length === n1, nodes.length - n1);
    check("...and no links", links.length === l1, links.length - l1);
    check("...and reports that it added nothing", r2.variants === 0 && r2.fitted === 0,
          r2.variants + "/" + r2.fitted);
  }

  // ---------- 5. an engine with no variants ----------
  {
    const stub = "{{Infobox automobile engine\n| name = Test T1\n| manufacturer = [[TestCo]]\n" +
      "| production = 1998-2010\n}}\nThe '''T1'''.\n== Applications ==\n" +
      "* 1998-2004 [[Mercedes-Benz E-Class (W213)|W213 E 200]]\n";
    const a = LF.readEngineArticle(stub, "T1");
    const { nodes, links } = graph();
    const r = await LF.applyEngineArticle(a, "Test T1", nodes, links, { resolve });
    check("an engine with no variants still reaches its car",
          r.variants === 0 && r.fitted === 1, r.variants + "/" + r.fitted);
    check("...straight from the engine node",
          links.some(l => l.type === "fitted" && l.source === r.engine.id && l.target === "m-mb-e-w213"));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
