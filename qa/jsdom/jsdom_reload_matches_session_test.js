// What a reload shows is what the session showed, and the rules that were
// settled alongside that.
//
// 1. Engines. Several titles that are one Wikipedia article are merged, and a
//    load used to do that one replayed line at a time: the first two titles
//    were merged before the article's own node existed, and the name of the
//    stand-in was lost when the real one arrived ("Isuzu V" kept its 6VE1 and
//    lost its 6VD1). A load now merges once, with every engine present.
// 2. Names. The same engine: another maker in front on both sides ("GM 2300"
//    and "Chevrolet 2300"), a layout word on the end ("Ford Flathead" and
//    "Ford flathead V8"), the same words in another order. A different engine:
//    any real extra designation ("M177 Evo"). A link that only adds a layout
//    or size word is not a new variant ("AJ34 V8" is the AJ34).
// 3. A code that a longer code merely contains is not that longer code: the
//    ASX's "4B11" is not the "4B11T".
// 4. One infobox line naming several engines keeps the car under each.
// 5. Un-merge is remembered.
// 6. A stored generation list is held against its article once, and what the
//    article states as a predecessor or successor is left out at replay.
// 7. A generation with no year has no year.
// 8. The Saab 95 is not the Saab 9-5.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
const ARTICLES = {};
function load(store, opts) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const w = dom.window;
  w.LLM_FAMILIES = Object.assign({ __serverAvailable: !!(opts && opts.server) }, store || {});
  w.__posts = [];
  w.fetch = (url, o) => {
    const u = String(url);
    if (u.indexOf("/api/llm-families") >= 0 && o && o.method === "POST") {
      w.__posts.push(o.body);
      return Promise.resolve(opts && opts.saveFails ? { ok: false, status: 500 } : { ok: true, status: 200, json: async () => ({ ok: true }) });
    }
    const page = u.match(/[?&]page=([^&]+)/);
    if (page) {
      const title = decodeURIComponent(page[1]).replace(/_/g, " ");
      if (ARTICLES[title]) return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": ARTICLES[title] } } }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }), text: async () => "" });
  };
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return { LF: w.LlmFamilies, w };
}
const idOf = v => (typeof v === "string" ? v : v.id);
const live = (nodes, type) => nodes.filter(n => n.type === type && !n.retired);
const linesOf = (links, nodes, carId) => links.filter(l => l.type === "fitted" && !l.retired &&
  (idOf(l.source) === carId || idOf(l.target) === carId)).map(l => {
    const e = nodes.find(n => n.id === (idOf(l.source) === carId ? idOf(l.target) : idOf(l.source)));
    const hub = e.type === "enginevar" ? nodes.find(n => n.id === e.engineOf) : e;
    return hub.label + " / " + (e.type === "enginevar" ? e.label : "-") + " / " + (l.saidText || "");
  }).sort();

(async () => {
  // ---------- 1. a load merges once, with every engine there ----------
  {
    const mention = (title, name, said) => ({ title, name, said, specs: {} });
    const store = {
      families: {}, relations: {}, recheck: {},
      wpRedirects: { "Isuzu 6VD1 engine": "Isuzu V engine", "Isuzu 6VE1 engine": "Isuzu V engine" },
      engineScans: {
        // Replayed in this order: the two redirect titles first, the
        // article's own title last -- the order that lost the 6VD1.
        "car-a": { engines: [mention("Isuzu 6VD1 engine", "6VD1", "3.2 L 6VD1 V6")], v: 9 },
        "car-b": { engines: [mention("Isuzu 6VE1 engine", "6VE1", "3.5 L 6VE1 V6")], v: 9 },
        "car-c": { engines: [mention("Isuzu V engine", "Isuzu V", "3.2 L V6")], v: 9 },
      },
    };
    const { LF } = load(store);
    const nodes = [
      { id: "mk-isuzu", type: "make", label: "Isuzu" },
      { id: "car-a", type: "model", label: "Trooper", make: "Isuzu", year: 1991 },
      { id: "car-b", type: "model", label: "VehiCROSS", make: "Isuzu", year: 1997 },
      { id: "car-c", type: "model", label: "Rodeo", make: "Isuzu", year: 1998 },
    ];
    const links = [];
    LF.applyWpLinks(nodes);
    LF.applyEngineMentions(nodes, links);
    check("the replay itself merges nothing", live(nodes, "engine").length === 3, live(nodes, "engine").map(e => e.label).join(", "));
    LF.applyEngineMerges(nodes, links);
    LF.tidyPowertrain(nodes, links);
    LF.tidyEngineLinks(nodes, links);
    const engines = live(nodes, "engine");
    check("one engine for the one article", engines.length === 1, engines.map(e => e.label).join(", "));
    check("...the article's own", engines[0] && engines[0].id === "eng-isuzu-v", engines[0] && engines[0].id);
    const vars = live(nodes, "enginevar").map(v => v.label).sort();
    check("both other names are kept as variants", vars.join(",") === "6VD1,6VE1", vars.join(","));
    check("the Trooper is on the 6VD1", linesOf(links, nodes, "car-a")[0] === "Isuzu V / 6VD1 / 3.2 L 6VD1 V6", linesOf(links, nodes, "car-a")[0]);
    check("the Rodeo is on the engine itself", linesOf(links, nodes, "car-c")[0] === "Isuzu V / - / 3.2 L V6", linesOf(links, nodes, "car-c")[0]);

    // A car that only exists late in a load is replayed after the merge, and
    // lands where the merge put its siblings.
    const late = { id: "car-d", type: "model", label: "MU", make: "Isuzu", year: 1989 };
    nodes.push(late);
    store.engineScans["car-d"] = { engines: [mention("Isuzu 6VD1 engine", "6VD1", "3.2 L 6VD1 V6")], v: 9 };
    LF.applyEngineMentions(nodes, links);
    LF.applyEngineMerges(nodes, links);
    check("a line replayed after the merge goes on the same variant",
          linesOf(links, nodes, "car-d")[0] === "Isuzu V / 6VD1 / 3.2 L 6VD1 V6", linesOf(links, nodes, "car-d")[0]);
  }

  // ---------- 2. the same name, and a different one ----------
  {
    const { LF } = load({});
    const merged = (primaryLabel, primaryWp, memberLabel, memberWp) => {
      const nodes = [
        { id: "eng-p", type: "engine", label: primaryLabel, wp: primaryWp, variants: [] },
        { id: "eng-m", type: "engine", label: memberLabel, wp: memberWp, variants: [], unresearched: true },
        { id: "mk-ford", type: "make", label: "Ford" }, { id: "mk-chevrolet", type: "make", label: "Chevrolet" },
        { id: "mk-gm", type: "make", label: "GM" }, { id: "mk-lincoln", type: "make", label: "Lincoln" },
        { id: "mk-buick", type: "make", label: "Buick" },
        { id: "car", type: "model", label: "Car", make: "Ford" },
      ];
      const links = [{ source: "eng-m", target: "car", type: "fitted", saidText: "a line" }];
      LF.applyWpLinks(nodes);
      LF.mergeEngines("eng-p", ["eng-m"], nodes, links);
      return live(nodes, "enginevar").map(v => v.label);
    };
    check("another maker in front, on both sides: the same engine",
          merged("Chevrolet 2300", "Chevrolet 2300 engine", "GM 2300", "GM 2300 engine").length === 0);
    check("a layout word on the end: the same engine",
          merged("Ford flathead V8", "Ford flathead V8 engine", "Ford Flathead", "Ford Flathead engine").length === 0);
    check("the same words in another order: the same engine",
          merged("General Motors LS-based small-block", "General Motors LS-based small-block engine",
                 "LS based GM small-block", "LS based GM small-block engine").length === 0);
    const evo = merged("M177", "Mercedes-Benz M177 engine", "M177 Evo", "Mercedes-Benz M177 Evo engine");
    check("a real extra designation: kept as its own variant", evo.join(",") === "M177 Evo", evo.join(","));
    const v6 = merged("Buick V8", "Buick V8 engine", "Buick V6", "Buick V6 engine");
    check("two different layouts are never the same engine", v6.join(",") === "Buick V6", v6.join(","));
  }

  // ---------- 2b. a link that only adds a layout or size word ----------
  {
    const { LF } = load({});
    const nodes = [
      { id: "eng-aj", type: "engine", label: "Jaguar AJ-V8", wp: "Jaguar AJ-V8 engine", variants: ["v-aj34"] },
      { id: "v-aj34", type: "enginevar", label: "AJ34", engineOf: "eng-aj" },
      { id: "c1", type: "model", label: "XK", make: "Jaguar" }, { id: "c2", type: "model", label: "XJ", make: "Jaguar" },
      { id: "c3", type: "model", label: "XF", make: "Jaguar" },
    ];
    const links = [
      { source: "eng-aj", target: "v-aj34", type: "enginegen" },
      { source: "eng-aj", target: "c1", type: "fitted", saidText: "4.2 L AJ34 V8", saidName: "AJ34 V8" },
      { source: "eng-aj", target: "c2", type: "fitted", saidText: "4.2 L AJ34 V8", saidName: "AJ34" },
      { source: "eng-aj", target: "c3", type: "fitted", saidText: "5.0 L AJ-V8", saidName: "Jaguar AJ-V8" },
    ];
    LF.tidyPowertrain(nodes, links);
    const vars = live(nodes, "enginevar").map(v => v.label);
    check("\"AJ34 V8\" on a link is the AJ34, not a new variant", vars.join(",") === "AJ34", vars.join(","));
    check("...and both cars are on it", linesOf(links, nodes, "c1")[0].indexOf("/ AJ34 /") > 0 && linesOf(links, nodes, "c2")[0].indexOf("/ AJ34 /") > 0);
    check("the engine's own name on a link stays on the engine", linesOf(links, nodes, "c3")[0].indexOf("/ - /") > 0, linesOf(links, nodes, "c3")[0]);
  }

  // ---------- 3. a code inside a longer code ----------
  {
    const { LF } = load({});
    const nodes = [
      { id: "eng-4b1", type: "engine", label: "Mitsubishi 4B1", wp: "Mitsubishi 4B1 engine", variants: ["v-4b11t"] },
      { id: "v-4b11t", type: "enginevar", label: "4B11T", engineOf: "eng-4b1" },
      { id: "asx", type: "model", label: "ASX", make: "Mitsubishi" }, { id: "evo", type: "model", label: "Lancer Evolution X", make: "Mitsubishi" },
      { id: "rvr", type: "model", label: "RVR", make: "Mitsubishi" },
    ];
    const links = [
      { source: "eng-4b1", target: "v-4b11t", type: "enginegen" },
      { source: "eng-4b1", target: "asx", type: "fitted", saidText: "2.0 L 4B11 I4", saidName: "4B11", variantHint: "4B11" },
      { source: "eng-4b1", target: "evo", type: "fitted", saidText: "2.0 L 4B11T turbo I4", saidName: "4B11T", variantHint: "4B11T" },
      { source: "eng-4b1", target: "rvr", type: "fitted", saidText: "2.0 L I4", variantHint: "2.0" },
    ];
    LF.tidyPowertrain(nodes, links);
    check("the ASX's 4B11 is not put on the 4B11T", linesOf(links, nodes, "asx")[0] === "Mitsubishi 4B1 / 4B11 / 2.0 L 4B11 I4", linesOf(links, nodes, "asx")[0]);
    check("the Evolution X is", linesOf(links, nodes, "evo")[0].indexOf("/ 4B11T /") > 0);
    check("a size on a link picks no variant by its digits", linesOf(links, nodes, "rvr")[0].indexOf("/ - /") > 0, linesOf(links, nodes, "rvr")[0]);
  }

  // ---------- 4. one line, several engines ----------
  {
    const { LF } = load({});
    const nodes = [
      { id: "eng-m50", type: "engine", label: "M50", wp: "BMW M50", variants: ["v-s50"] },
      { id: "v-s50", type: "enginevar", label: "S50", engineOf: "eng-m50" },
      { id: "e36", type: "model", label: "3 Series (E36)", make: "BMW" },
    ];
    const said = "2.0–3.2 L M50/M52/S50/S52 I6";
    const links = [
      { source: "eng-m50", target: "v-s50", type: "enginegen" },
      { source: "eng-m50", target: "e36", type: "fitted", saidText: said, saidName: "M50", fromCar: true },
      { source: "v-s50", target: "e36", type: "fitted", saidText: said, saidName: "S50", fromCar: true },
    ];
    LF.tidyEngineLinks(nodes, links);
    check("the E36 keeps its M50 beside its S50", linesOf(links, nodes, "e36").length === 2, linesOf(links, nodes, "e36").join(" ; "));
    // ...where the same line said twice is still one line.
    links.push({ source: "v-s50", target: "e36", type: "fitted", saidText: said, saidName: "S50", fromCar: true });
    LF.tidyEngineLinks(nodes, links);
    check("the same line twice is still dropped", linesOf(links, nodes, "e36").length === 2, linesOf(links, nodes, "e36").join(" ; "));
  }

  // ---------- 5. un-merge is remembered ----------
  {
    const store = { families: {}, relations: {}, recheck: {}, wpRedirects: { "BMW S58": "BMW B58" } };
    const { LF, w } = load(store, { server: true });
    const mk = () => [
      { id: "eng-bmw-b58", type: "engine", label: "B58", wp: "BMW B58", variants: [] },
      { id: "eng-bmw-s58", type: "engine", label: "S58", wp: "BMW S58", variants: [], unresearched: true },
    ];
    let nodes = mk(), links = [];
    LF.applyEngineMerges(nodes, links);
    check("the redirect merges the two", live(nodes, "engine").length === 1);
    await LF.undoEngineMerge("eng-bmw-b58");
    nodes = mk(); links = [];
    LF.applyEngineMerges(nodes, links);
    check("after Un-merge the automatic check leaves them apart", live(nodes, "engine").length === 2, live(nodes, "engine").map(e => e.label).join(", "));
    check("...and that is saved", w.__posts.some(b => /engineUnmerges/.test(b) && /eng-bmw-b58\|eng-bmw-s58/.test(b)));
    LF.mergeEngines("eng-bmw-b58", ["eng-bmw-s58"], nodes, links);
    check("a merge by hand overrides it", live(nodes, "engine").length === 1);
  }

  // ---------- 6. the stored lists, held against their articles once ----------
  {
    ARTICLES["Testco Alpha"] = [
      "{{Infobox automobile", "| name = Testco Alpha", "| predecessor = [[Testco Zeta|Testco Zeta (Z9)]]", "}}",
      "The Alpha is a car.",
      "== Predecessor models ==", "=== Z1 (1980) ===", "The Z1 came first.",
      "== First generation (A1; 1990) ==", "Text.",
      "== <span class=\"anchor\" id=\"A2\"></span>Second generation (2000) ==", "Text.",
      "== Successor (B1; 2010) ==", "Text.",
    ].join("\n");
    const store = { families: { "m-alpha": { status: "confirmed", checkedAt: "2026-09-01T00:00:00Z", sourceTitle: "Testco Alpha",
      proposal: { hasMultipleGenerations: true, generations: [
        { code: "Z1", yearStart: 1980, yearEnd: 1990 }, { code: "A1", yearStart: 1990, yearEnd: 2000 },
        { code: "A2", yearStart: 2000, yearEnd: 2010 }, { code: "B1", yearStart: 2010, yearEnd: null }] } } },
      relations: {}, recheck: {} };
    const { LF, w } = load(store, { server: true });
    const r = await LF.sweepStoredSplitsForOutsiders({ pauseMs: 0 });
    check("one stored list is checked", r.checked === 1, r.checked);
    check("the predecessor and the successor are set aside", r.setAside.map(x => x.code).sort().join(",") === "B1,Z1", r.setAside.map(x => x.code).join(","));
    check("...and that is saved on the entry", w.__posts.some(b => /"outsiders"/.test(b)));
    const nodes = [{ id: "mk-t", type: "make", label: "Testco" }, { id: "m-alpha", type: "model", label: "Alpha", make: "Testco", year: 1980, wp: "Testco Alpha" }];
    const links = [];
    LF.applyConfirmed(nodes, links);
    const gens = nodes.filter(n => n.familyOf === "m-alpha" && !n.retired).map(n => n.label);
    check("the replay leaves them out", gens.join(",") === "Alpha A1,Alpha A2", gens.join(","));
    const again = await LF.sweepStoredSplitsForOutsiders({ pauseMs: 0 });
    check("a list already checked is not read again", again.checked === 0, again.checked);
  }

  // ---------- 7. a generation with no year has no year ----------
  {
    const store = { families: { "m-beta": { status: "confirmed", checkedAt: "2026-10-20T00:00:00Z", sourceTitle: "Testco Beta",
      proposal: { hasMultipleGenerations: true, generations: [
        { code: "B1", yearStart: 2006, yearEnd: 2012 }, { code: "B2", yearStart: null, yearEnd: null },
        { code: "B3", yearStart: 2010, yearEnd: 11 }, { code: "B4", yearStart: 2099, yearEnd: null }] } } },
      relations: {}, recheck: {} };
    const { LF } = load(store);
    const nodes = [{ id: "mk-t", type: "make", label: "Testco" }, { id: "m-beta", type: "model", label: "Beta", make: "Testco", year: 2006 }];
    LF.applyConfirmed(nodes, []);
    const g = code => nodes.find(n => n.familyOf === "m-beta" && n.label === "Beta " + code);
    check("an undated generation is not given the nameplate's first year", g("B2") && g("B2").year == null, g("B2") && g("B2").year);
    check("an end year written short is read in full", g("B3") && g("B3").end === 2011, g("B3") && g("B3").end);
    check("a start year that far ahead is not a year", g("B4") && g("B4").year == null, g("B4") && g("B4").year);
  }

  // ---------- 8. the Saab 95 is not the Saab 9-5 ----------
  {
    const { LF } = load({});
    const nodes = [
      { id: "fam-95", type: "family", label: "9-5", make: "Saab", generations: ["g1"], year: 1997 },
      { id: "g1", type: "model", label: "9-5 YS3E", make: "Saab", familyOf: "fam-95", year: 1997 },
      { id: "m-95", type: "model", label: "95", make: "Saab", year: 1959, end: 1978 },
      { id: "fam-crv", type: "family", label: "CR-V", make: "Honda", generations: ["g2"], year: 1995 },
      { id: "g2", type: "model", label: "CR-V RD1", make: "Honda", familyOf: "fam-crv", year: 1995 },
      { id: "m-crv", type: "model", label: "CRV", make: "Honda", year: 1995 },
    ];
    LF.mergeDuplicateNameplates(nodes, []);
    const saab = nodes.find(n => n.id === "m-95"), crv = nodes.find(n => n.id === "m-crv");
    check("the Saab 95 stays its own car", !saab.familyOf && !saab.retired);
    check("\"CRV\" is still the CR-V", !!(crv.familyOf || crv.retired));
  }

  // ---------- 9. a save the server turns down ----------
  {
    const { LF, w } = load({ families: {}, relations: {}, recheck: {} }, { server: true, saveFails: true });
    await LF.unmergeDuplicate("fam-x", "m-x");       // any change that saves
    check("a rejected save is reported", !!LF.lastSaveError(), LF.lastSaveError());
    check("...on the page", !!w.document.getElementById("llm-save-failed"));
  }

  // ---------- 10. a name inside another name is not that car ----------
  {
    const fam = (id, gens) => ({ [id]: { status: "confirmed", checkedAt: "2026-10-20T00:00:00Z", sourceTitle: id,
      proposal: { hasMultipleGenerations: true, generations: gens } } });
    const store = { families: fam("m-milan", [
      { code: "First generation", yearStart: 2005, yearEnd: 2009, sharedPlatforms: ["Ford Fusion", "1960 Ford", "Chevrolet/GMC C/K"] },
      { code: "Second generation", yearStart: 2010, yearEnd: 2011 }]), relations: {}, recheck: {} };
    const { LF } = load(store);
    const nodes = [
      { id: "mk-mercury", type: "make", label: "Mercury" }, { id: "mk-ford", type: "make", label: "Ford" },
      { id: "mk-saturn", type: "make", label: "Saturn" }, { id: "mk-chevrolet", type: "make", label: "Chevrolet" },
      { id: "m-milan", type: "model", label: "Milan", make: "Mercury", year: 2005 },
      { id: "m-ion", type: "model", label: "Ion", make: "Saturn", year: 2002, end: 2007 },
      { id: "m-ck", type: "model", label: "C/K", make: "Chevrolet", year: 1960, end: 2002 },
    ];
    const links = [];
    LF.applyConfirmed(nodes, links);
    const gen1 = nodes.find(n => n.familyOf === "m-milan" && /First/.test(n.label));
    const partners = links.filter(l => l.type === "platform" && (idOf(l.source) === gen1.id || idOf(l.target) === gen1.id))
      .map(l => idOf(l.source) === gen1.id ? idOf(l.target) : idOf(l.source));
    const fusion = nodes.find(n => n.make === "Ford" && n.label === "Fusion");
    check("\"Ford Fusion\" is made as a Ford, not matched to the Saturn Ion", !!fusion && !Object.keys(store.relations).some(k => /m-ion/.test(k)),
          Object.keys(store.relations).join(" ; "));
    const y60 = nodes.find(n => n.label === "1960 Ford");
    check("\"1960 Ford\" is a Ford", !!y60 && y60.make === "Ford", y60 && y60.make);
    check("...and no make called \"1960\" is invented", !nodes.some(n => n.type === "make" && n.label === "1960"));
    check("\"Chevrolet/GMC C/K\" is the Chevrolet C/K, with no make of that name",
          !nodes.some(n => n.type === "make" && /\//.test(n.label)), nodes.filter(n => n.type === "make").map(n => n.label).join(", "));
  }

  // ---------- 11. the same decisions, in another order, build the same graph ----------
  {
    const gensA = [{ code: "A1", yearStart: 1990, yearEnd: 1999, sharedPlatforms: ["Testco Beta"] }, { code: "A2", yearStart: 2000, yearEnd: 2009 }];
    const gensB = [{ code: "B1", yearStart: 1991, yearEnd: 1998 }, { code: "B2", yearStart: 2001, yearEnd: 2008 }];
    const entry = gens => ({ status: "confirmed", checkedAt: "2026-10-20T00:00:00Z", sourceTitle: "x", proposal: { hasMultipleGenerations: true, generations: gens } });
    const build = order => {
      const families = {};
      order.forEach(id => { families[id] = entry(id === "m-alpha" ? gensA : gensB); });
      const store = { families, relations: {}, recheck: {} };
      const { LF } = load(store);
      const nodes = [{ id: "mk-t", type: "make", label: "Testco" },
        { id: "m-alpha", type: "model", label: "Alpha", make: "Testco", year: 1990 },
        { id: "m-beta", type: "model", label: "Beta", make: "Testco", year: 1991 }];
      LF.applyConfirmed(nodes, []);
      return Object.keys(store.relations).sort().join(" ; ");
    };
    const ab = build(["m-alpha", "m-beta"]), ba = build(["m-beta", "m-alpha"]);
    check("the order decisions sit in the file does not change what is built", ab === ba, ab + "  vs  " + ba);
    check("...and the mention lands on the generation built alongside", /llm-m-alpha-a1\|llm-m-beta-b1/.test(ab), ab);
  }

  // ---------- 12. "Octavia Mk2" is the generation the article says it is ----------
  {
    ARTICLES["Testco Gamma"] = ["Intro.", "== First generation (Typ 1U; 1996) ==", "Text.", "== Second generation (Typ 1Z; 2004) ==", "Text."].join("\n");
    const store = { families: {}, relations: {}, recheck: {} };
    const { LF } = load(store, { server: true });
    const mk = () => [
      { id: "mk-t", type: "make", label: "Testco" },
      { id: "fam-g", type: "family", label: "Gamma", make: "Testco", wp: "Testco Gamma", generations: ["g-1u", "g-1z"] },
      { id: "g-1u", type: "model", label: "Gamma 1U", make: "Testco", familyOf: "fam-g", year: 1996 },
      { id: "g-1z", type: "model", label: "Gamma 1Z", make: "Testco", familyOf: "fam-g", year: 2004 },
      { id: "llm-related-testco-gamma-mk2", type: "model", label: "Gamma Mk2", make: "Testco", llmGenerated: true, llmCreatedNode: true },
    ];
    let nodes = mk();
    LF.foldCodeDuplicateModels(nodes, []);
    check("counting to the second generation by date is not done", !nodes.find(n => n.id === "llm-related-testco-gamma-mk2").retired);
    const r = await LF.sweepOrdinalPlaceholders(nodes);
    check("the article's heading says which generation the ordinal is", r.found === 1, JSON.stringify(r));
    nodes = mk();
    LF.foldCodeDuplicateModels(nodes, []);
    const ph = nodes.find(n => n.id === "llm-related-testco-gamma-mk2");
    check("...and at the next load the placeholder is that generation", ph.retired && ph.supersededBy === "g-1z", ph.supersededBy);
  }

  // ---------- 13. another title of the same engine, and one that is not ----------
  {
    const { LF } = load({});
    const run = (primaryLabel, primaryWp, memberLabel, memberWp, famLine, memberLine) => {
      const nodes = [
        { id: "eng-p", type: "engine", label: primaryLabel, wp: primaryWp, variants: [] },
        { id: "eng-m", type: "engine", label: memberLabel, wp: memberWp, variants: [], unresearched: true },
        { id: "mk-gm", type: "make", label: "GM" }, { id: "mk-olds", type: "make", label: "Oldsmobile" },
        { id: "c1", type: "model", label: "One", make: "GM" }, { id: "c2", type: "model", label: "Two", make: "GM" },
      ];
      const links = [
        { source: "eng-p", target: "c1", type: "fitted", saidText: famLine.text, saidSpecs: famLine.specs },
        { source: "eng-m", target: "c2", type: "fitted", saidText: memberLine.text, saidSpecs: memberLine.specs },
      ];
      LF.applyWpLinks(nodes);
      LF.mergeEngines("eng-p", ["eng-m"], nodes, links);
      return { vars: live(nodes, "enginevar").map(v => v.label), aka: LF.aliasesFor("eng-p") };
    };
    const v8 = { text: "6.0 L V8", specs: { layout: "V", cylinders: 8 } }, v6 = { text: "4.3 L V6", specs: { layout: "V", cylinders: 6 } };
    const ls = run("General Motors LS-based small-block", "General Motors LS-based small-block engine", "GM LS", "GM LS engine", v8, v8);
    check("a shorter title of the same article is the same engine", ls.vars.length === 0, ls.vars.join(","));
    check("...and is listed as also called", ls.aka.indexOf("GM LS") >= 0, ls.aka.join(","));
    const od = run("Oldsmobile Diesel", "Oldsmobile Diesel engine", "Oldsmobile Diesel V6", "Oldsmobile Diesel V6 engine", v8, v6);
    check("a layout the family's cars contradict keeps the engine apart", od.vars.join(",") === "Oldsmobile Diesel V6", od.vars.join(","));
    const same = run("Lincoln Y-block", "Lincoln Y-block engine", "Lincoln Y-block V8", "Lincoln Y-block V8 engine", v8, v8);
    check("a layout they agree on does not", same.vars.length === 0, same.vars.join(","));
  }

  console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
