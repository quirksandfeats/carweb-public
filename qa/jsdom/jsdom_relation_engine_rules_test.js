// Five reports from one review (2026-10-11):
//   1. the Chevrolet Suburban was joined to the Goggomobil Dart ("Dartz" in
//      its article): the sanity check's pick is now tested before use, and
//      confirmed picks that fail the test are taken back at boot;
//   2. the Toyota Supra A80 had every generation's engines: an article that
//      turns out to be the nameplate's own page (a redirect), or covers
//      several cars, is read only for this car's section;
//   3. engine reads that landed on another car's page are not replayed;
//   4. a nameplate-level link is not shown beside a generation-level one;
//   5. the review queue is decided by rules where the evidence allows.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot({ nodes = [], links = [], store = {}, pages = {} } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  const saved = { last: null };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u === "/api/llm-families" && opts && opts.body) { try { saved.last = JSON.parse(opts.body); } catch (e) {} }
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      const m = decodeURIComponent(u).match(/page=([^&]+)/);
      const asked = m ? m[1].replace(/\+/g, " ").replace(/_/g, " ") : "";
      const pg = pages[asked];
      const title = pg ? (pg.served || asked) : asked;
      const wt = pg ? pg.text : "A car.";
      return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  nodes.forEach(n => window.CARDATA.nodes.push(JSON.parse(JSON.stringify(n))));
  links.forEach(l => window.CARDATA.links.push(JSON.parse(JSON.stringify(l))));
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {} }, JSON.parse(JSON.stringify(store)),
    { __serverAvailable: true, __config: { cascadeMaxDepth: 1 } });
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  const cw = window.CarWeb;
  cw.boot();
  return { window, cw, LF: window.LlmFamilies, saved };
}
const mk = (id, label, make, year, end, extra) => Object.assign({ id, type: "model", label, make, year, end }, extra || {});

(async () => {
  // ---------- 1. the sanity check's pick ----------
  console.log("--- 1. a pick the mention does not support ---");
  {
    const { LF } = boot();
    const sub = mk("x-sub", "Suburban Ninth generation", "Chevrolet", 2007, 2014);
    const dart = mk("x-dart", "Dart", "Goggomobil", 1959, 1961);
    const nodes = [sub, dart];
    check("\"Dartz\" does not name the Dart", !LF.sanityMatchPlausible(sub, dart, "Dartz", nodes).ok,
      JSON.stringify(LF.sanityMatchPlausible(sub, dart, "Dartz", nodes)));
    const fam208 = { id: "x-208", type: "family", label: "208", make: "Peugeot", generations: ["x-208a", "x-208b"] };
    const g1 = mk("x-208a", "208 A9", "Peugeot", 2012, 2020, { familyOf: "x-208" });
    const g2 = mk("x-208b", "208 P21", "Peugeot", 2019, null, { familyOf: "x-208" });
    const ds = mk("x-ds3", "DS 3 Second generation (D34)", "DS", 2018, null);
    const n2 = [fam208, g1, g2, ds];
    check("\"Peugeot 208 II\" is the second 208, not the first", !LF.sanityMatchPlausible(ds, g1, "Peugeot 208 II", n2).ok);
    const ok2 = LF.sanityMatchPlausible(ds, g2, "Peugeot 208 II", n2);
    check("...and is the second, by name", ok2.ok && ok2.exact, JSON.stringify(ok2));
    const sal = mk("x-408s", "408 (saloon)", "Peugeot", 2010, null);
    check("\"408 (crossover)\" is not the 408 (saloon)", !LF.sanityMatchPlausible(ds, sal, "Peugeot 408 (crossover)", [ds, sal]).ok);
    const dv = mk("x-dv", "de Ville series", "Cadillac", 1959, 2005);
    const o98 = mk("x-98", "98 Tenth generation", "Oldsmobile", 1977, 1984);
    check("\"Cadillac DeVille\" names the de Ville series", LF.sanityMatchPlausible(o98, dv, "Cadillac DeVille", [o98, dv]).ok);
    const r4 = mk("x-r4", "400 / 45", "Rover", 1990, 2005), gem = mk("x-gem", "Gemini Fourth generation", "Isuzu", 1990, 1993);
    check("\"Rover 400\" names the Rover 400 / 45", LF.sanityMatchPlausible(gem, r4, "Rover 400", [gem, r4]).ok);
    const lv = mk("x-ae86", "Corolla Levin AE86", "Toyota", 1983, 1987), spr = mk("x-spr", "Sprinter E20", "Toyota", 1970, 1974);
    check("\"Corolla Levin (TE27)\" is not the AE86", !LF.sanityMatchPlausible(spr, lv, "Toyota Corolla Levin (TE27)", [spr, lv]).ok);
    const mini = mk("x-mini", "Mini Mark I", "Austin", 1959, 1967), cl = mk("x-cl", "Clubman (2007)", "Mini", 2007, 2024);
    check("a platform is not shared forty years apart", !LF.sanityMatchPlausible(mini, cl, "Mini Clubman", [mini, cl]).ok);
    const ib = { id: "x-ib", type: "family", label: "Ibiza", make: "SEAT", generations: ["x-ib1", "x-ib2", "x-ib3", "x-ib4", "x-ib5"] };
    const ibs = [1984, 1993, 2002, 2008, 2017].map((y, i) => mk("x-ib" + (i + 1), "Ibiza G" + (i + 1), "SEAT", y, y + 8, { familyOf: "x-ib" }));
    const a1 = mk("x-a1", "A1 GB", "Audi", 2018, null);
    const v = LF.sanityMatchPlausible(a1, ibs[4], "SEAT Ibiza Mk5", [ib, a1].concat(ibs));
    check("\"Mk5\" is the fifth generation", v.ok && v.exact, JSON.stringify(v));

    // the same test over a pick confirmed before it existed
    const nodesB = [
      { id: "mk-ttst", type: "make", label: "TTst", year: 1950 },
      mk("m-ttst-sub", "Suburban", "TTst", 2007, 2014, { wp: "TTst Suburban" }),
      mk("m-ttst-dart", "Dart", "TTst", 1959, 1961, { wp: "TTst Dart" }),
    ];
    const key = "m-ttst-dart|m-ttst-sub|platform";
    const t = boot({ nodes: nodesB, links: nodesB.slice(1).map(n => ({ source: n.id, target: "mk-ttst", type: "made" })),
      store: { relations: { [key]: { status: "confirmed", relType: "platform", famA: "m-ttst-sub", famB: "m-ttst-dart",
        genIdA: "m-ttst-sub", genIdB: "m-ttst-dart",
        reason: 'auto-approved in the background -- the local LLM sanity check confidently identified this as the same car as "Dartz" (confidence: high) -- a known misspelling' } } } });
    check("a confirmed pick that fails the test is taken back at boot", !t.LF.relationEntryFor(key));
    check("...and not drawn", !t.cw.links.some(l => l.type === "platform" && !l.retired &&
      [l.sn && l.sn.id, l.tn && l.tn.id].sort().join() === "m-ttst-dart,m-ttst-sub"));
  }

  // ---------- 2/3. engines read off a page covering several cars ----------
  console.log("\n--- 2. an article that is the nameplate's own page ---");
  {
    const plate = `{{Infobox automobile|name=Supra}}\nThe Supra.\n== Third generation (A70; 1986) ==\n{{Infobox automobile\n| engine = [[ETst 7M engine|7M-GE]]\n}}\nThird.\n== Fourth generation (A80; 1993) ==\n{{Infobox automobile\n| engine = [[ETst JZ engine|2JZ-GTE]]\n}}\nFourth.`;
    const nodesE = [
      { id: "mk-etst", type: "make", label: "ETst", year: 1950 },
      { id: "fam-etst-supra", type: "family", label: "Supra", make: "ETst", year: 1986, end: 2002, wp: "ETst Supra",
        generations: ["m-etst-supra-a70", "m-etst-supra-a80"], designers: [], engineers: [] },
      mk("m-etst-supra-a70", "Supra A70", "ETst", 1986, 1993, { familyOf: "fam-etst-supra", wp: "ETst Supra (A70)" }),
      mk("m-etst-supra-a80", "Supra A80", "ETst", 1993, 2002, { familyOf: "fam-etst-supra", wp: "ETst Supra (A80)" }),
    ];
    const linksE = nodesE.slice(1).map(n => ({ source: n.id, target: "mk-etst", type: "made" }))
      .concat([{ source: "fam-etst-supra", target: "m-etst-supra-a70", type: "generation" },
               { source: "fam-etst-supra", target: "m-etst-supra-a80", type: "generation" }]);
    const { cw, LF } = boot({ nodes: nodesE, links: linksE, pages: {
      "ETst Supra": { text: plate },
      "ETst Supra (A80)": { text: plate, served: "ETst Supra" },     // a redirect to the nameplate's page
      "ETst Supra (A70)": { text: plate },                             // not a redirect, but it covers both cars
    } });
    await LF.scanEnginesFor(cw.byId.get("fam-etst-supra"), cw.nodes, cw.links);
    const names = id => ((LF.engineScanEntryFor(id) || {}).engines || []).map(h => h.name).join(",");
    check("the A80 gets only the A80's engine", names("m-etst-supra-a80") === "2JZ-GTE", names("m-etst-supra-a80"));
    check("the A70, whose page covers both cars, gets only its own", names("m-etst-supra-a70") === "7M-GE", names("m-etst-supra-a70"));
  }
  console.log("\n--- 3. a stored read from another car's page is not shown ---");
  {
    const nodesS = [
      { id: "mk-stst", type: "make", label: "STst", year: 1950 },
      { id: "fam-stst-carina", type: "family", label: "Carina", make: "STst", year: 1970, end: 2001, wp: "STst Carina",
        generations: ["m-stst-carina-a40"], designers: [], engineers: [] },
      mk("m-stst-carina-a40", "Carina A40", "STst", 1977, 1981, { familyOf: "fam-stst-carina", wp: "STst Carina" }),
      { id: "fam-stst-supra", type: "family", label: "Supra", make: "STst", year: 1978, end: 2002, wp: "STst Supra",
        generations: ["m-stst-supra-a60"], designers: [], engineers: [] },
      mk("m-stst-supra-a60", "Supra A60", "STst", 1981, 1985, { familyOf: "fam-stst-supra" }),
    ];
    const linksS = nodesS.slice(1).map(n => ({ source: n.id, target: "mk-stst", type: "made" }));
    const rec = { checkedAt: "2026-01-01", sourceTitle: "STst Carina (A60)", section: "x", v: 5,
      engines: [{ title: "STst T engine", name: "2T", variant: null, specs: {}, said: "2T" }], unlinked: [] };
    const { cw, LF } = boot({ nodes: nodesS, links: linksS, store: {
      wpRedirects: { "STst Carina (A60)": "STst Carina" }, engineScans: { "m-stst-supra-a60": rec } } });
    check("not replayed", !cw.links.some(l => l.type === "fitted" && !l.retired &&
      ((l.sn && l.sn.id) === "m-stst-supra-a60" || (l.tn && l.tn.id) === "m-stst-supra-a60")));
    const r = LF.engineScanEntryFor("m-stst-supra-a60");
    check("...and due to be read again", r && r.v === 0 && /several cars/.test(r.staleReason || ""), JSON.stringify(r && { v: r.v, s: r.staleReason }));
  }

  // ---------- 4. covered nameplate links ----------
  console.log("\n--- 4. no nameplate edge beside a generation edge ---");
  {
    const nodesC = [
      { id: "mk-ctst", type: "make", label: "CTst", year: 1950 },
      { id: "fam-ctst-sc", type: "family", label: "SC", make: "CTst", year: 1991, end: 2010, generations: ["m-ctst-sc-z30", "m-ctst-sc-z40"], designers: [], engineers: [] },
      mk("m-ctst-sc-z30", "SC Z30", "CTst", 1991, 2000, { familyOf: "fam-ctst-sc" }),
      mk("m-ctst-sc-z40", "SC Z40", "CTst", 2001, 2010, { familyOf: "fam-ctst-sc" }),
      mk("m-ctst-a80", "Supra A80", "CTst", 1993, 2002),
    ];
    const linksC = nodesC.slice(1).map(n => ({ source: n.id, target: "mk-ctst", type: "made" })).concat([
      { source: "fam-ctst-sc", target: "m-ctst-sc-z30", type: "generation" },
      { source: "fam-ctst-sc", target: "m-ctst-sc-z40", type: "generation" },
      { source: "m-ctst-a80", target: "fam-ctst-sc", type: "platform" },
      { source: "m-ctst-a80", target: "m-ctst-sc-z30", type: "platform" },
    ]);
    const { cw, window } = boot({ nodes: nodesC, links: linksC });
    const coarse = cw.links.find(l => l.type === "platform" && l.sn && l.sn.id === "m-ctst-a80" && l.tn.id === "fam-ctst-sc");
    check("the nameplate link knows the generation link covers it", coarse && coarse.coveredBy && coarse.coveredBy.length === 1);
    cw.openDetail(cw.byId.get("m-ctst-a80"));
    const card = window.document.querySelector(".dt-connections").textContent;
    check("the card lists the generation, not the nameplate", /SC Z30/.test(card) && !/CTst SC\s*\d{4}/.test(card.replace(/SC Z30\s*\d{4}/, "")), card);
  }

  // ---------- 5. the review queue ----------
  console.log("\n--- 5. deciding the review queue by rule ---");
  {
    const nodesR = [
      { id: "mk-rtst", type: "make", label: "RTst", year: 1950 },
      { id: "fam-rtst-qq", type: "family", label: "Qashqai", make: "RTst", year: 2006, end: null, generations: ["m-rtst-qq-j10", "m-rtst-qq-j11"], designers: [], engineers: [] },
      mk("m-rtst-qq-j10", "Qashqai J10", "RTst", 2006, 2013, { familyOf: "fam-rtst-qq" }),
      mk("m-rtst-qq-j11", "Qashqai J11", "RTst", 2013, 2021, { familyOf: "fam-rtst-qq" }),
      mk("m-rtst-koleos", "Koleos HY", "RTst", 2007, 2016, { sharedPlatformTexts: ["RTst Qashqai (J10)"] }),
      mk("m-rtst-pulsar", "Pulsar C13", "RTst", 2014, 2018, { sharedPlatformTexts: ["RTst Qashqai (J11)"] }),
      mk("m-rtst-diplo", "Diplomat", "RTst", 2014, 2018, { sharedPlatformTexts: ["RTst Aspen"] }),
      mk("m-rtst-xc60", "XC60 First generation", "RTst", 2008, 2012, { sharedPlatformTexts: ["RTst Qashqai"] }),
    ];
    const linksR = nodesR.slice(1).map(n => ({ source: n.id, target: "mk-rtst", type: "made" })).concat([
      { source: "fam-rtst-qq", target: "m-rtst-qq-j10", type: "generation" },
      { source: "fam-rtst-qq", target: "m-rtst-qq-j11", type: "generation" }]);
    const prov = (a, b) => ({ status: "provisional", relType: "platform", famA: a, famB: b, genIdA: a, genIdB: b,
      reason: "proposed by overlapping production years only, on top of a nameplate name that only matched as a substring" });
    const rel = {
      "fam-rtst-qq|m-rtst-koleos|platform": prov("m-rtst-koleos", "fam-rtst-qq"),
      "m-rtst-pulsar|m-rtst-qq-j10|platform": prov("m-rtst-pulsar", "m-rtst-qq-j10"),
      "m-rtst-diplo|m-rtst-qq-j11|platform": prov("m-rtst-diplo", "m-rtst-qq-j11"),
      "m-rtst-gone|m-rtst-qq-j11|platform": prov("m-rtst-gone", "m-rtst-qq-j11"),
      "m-rtst-qq-j10|m-rtst-xc60|platform": prov("m-rtst-xc60", "m-rtst-qq-j10"),
    };
    const { LF } = boot({ nodes: nodesR, links: linksR, store: { relations: rel } });
    const st = k => { const e = LF.relationEntryFor(k); return e ? e.status : "none"; };
    check("a nameplate the mention names a generation of is stepped down to it and confirmed",
      st("m-rtst-koleos|m-rtst-qq-j10|platform") === "confirmed" && st("fam-rtst-qq|m-rtst-koleos|platform") === "none");
    check("the mention names a different generation: refused", st("m-rtst-pulsar|m-rtst-qq-j10|platform") === "none");
    check("no mention names it at all: refused", st("m-rtst-diplo|m-rtst-qq-j11|platform") === "none");
    check("one side gone: dropped", st("m-rtst-gone|m-rtst-qq-j11|platform") === "none");
    check("the nameplate named, and only one generation built alongside: confirmed",
      st("m-rtst-qq-j10|m-rtst-xc60|platform") === "confirmed",
      st("m-rtst-qq-j10|m-rtst-xc60|platform"));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
