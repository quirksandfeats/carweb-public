// Four things from one report (2026-10-10):
//   1. a cascade also walks a car's predecessors and successors, one hop each,
//      under the same depth budget (the Lykan HyperSport's successor was never
//      checked);
//   2. a reply missing only its last closing brace is not a failed check (the
//      Boxster and Cayman);
//   3. a plain car that is one of a nameplate's generations under another
//      name is folded into it (the "718 Boxster and Cayman (982)" beside the
//      nameplate's own 982, which held the engines);
//   4. the infobox's "also called" names are read and shown on the card.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot({ cascadeMaxDepth = 1, extraNodes = [], extraLinks = [], store = {}, articles = {}, llm } = {}) {
  const checked = [];
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      const m = decodeURIComponent(u).match(/page=([^&]+)/);
      const title = m ? m[1].replace(/\+/g, " ").replace(/_/g, " ") : "";
      const wt = articles[title] || "A car.";
      return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const sys = String(body.messages[0].content), user = String(body.messages[1].content);
      if (sys.includes("You extract car production-generation data")) {
        const mm = user.match(/^Car:\s*(.+)$/m);
        const car = mm ? mm[1].trim() : "";
        checked.push(car);
        const reply = llm ? llm(car) : { hasMultipleGenerations: false, generations: [] };
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ matchId: null, confidence: "low", reason: "n/a", resolved: false }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  const DATA = window.CARDATA;
  // Copies: a boot rewrites what it is given (types, link endpoints).
  extraNodes.forEach(n => DATA.nodes.push(JSON.parse(JSON.stringify(n))));
  extraLinks.forEach(l => DATA.links.push(JSON.parse(JSON.stringify(l))));
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {} }, store,
    { __serverAvailable: true, __config: { cascadeMaxDepth } });
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  return { window, cw, checked, LF: window.LlmFamilies };
}

(async () => {
  // ---------- 1. succession counts as a hop ----------
  // Aaz's article names Bez as a platform partner. Bez has a successor, Cez,
  // that nothing names -- only the graph's succession link joins them.
  const chainNodes = [
    { id: "mk-succtest", type: "make", label: "SuccTest", year: 1950 },
    { id: "m-succtest-aaz", type: "model", label: "Aaz", make: "SuccTest", wp: "SuccTest Aaz", year: 2000, end: 2010 },
    { id: "m-succtest-bez", type: "model", label: "Bez", make: "SuccTest", wp: "SuccTest Bez", year: 2000, end: 2010 },
    { id: "m-succtest-cez", type: "model", label: "Cez", make: "SuccTest", wp: "SuccTest Cez", year: 2010, end: 2020 },
  ];
  const chainLinks = [
    { source: "m-succtest-aaz", target: "mk-succtest", type: "made" },
    { source: "m-succtest-bez", target: "mk-succtest", type: "made" },
    { source: "m-succtest-cez", target: "mk-succtest", type: "made" },
    { source: "m-succtest-bez", target: "m-succtest-cez", type: "succession" },
  ];
  const chainArticles = {
    "SuccTest Aaz": "The Aaz was built as the Aaz1 and the Aaz2. It shares its platform with the SuccTest Bez.\n== Aaz1 ==\nfirst.\n== Aaz2 ==\nsecond.",
    "SuccTest Bez": "The Bez is a car. It was succeeded by the Cez.",
    "SuccTest Cez": "The Cez is a car.",
  };
  const chainLlm = car => /Aaz/.test(car)
    ? { hasMultipleGenerations: true, generations: [
        { code: "Aaz1", yearStart: 2000, yearEnd: 2005, designers: [], engineers: [], sharedPlatforms: [] },
        { code: "Aaz2", yearStart: 2005, yearEnd: 2010, designers: [], engineers: [], sharedPlatforms: ["SuccTest Bez"] } ] }
    : { hasMultipleGenerations: false, generations: [] };
  console.log("--- 1. predecessors and successors are cascade hops ---");
  for (const depth of [2, 1]) {
    const { cw, checked } = boot({ cascadeMaxDepth: depth, extraNodes: chainNodes, extraLinks: chainLinks,
                                   articles: chainArticles, llm: chainLlm });
    cw.setLlmCheck(true);
    cw.openDetail(cw.byId.get("m-succtest-aaz"));
    await sleep(1800);
    const saw = c => checked.some(x => x.includes(c));
    check(`depth ${depth}: the clicked car and its platform partner are checked`, saw("Aaz") && saw("Bez"), JSON.stringify(checked));
    if (depth === 2) check("depth 2: the partner's successor is checked too -- one more hop", saw("Cez"), JSON.stringify(checked));
    else check("depth 1: the partner's successor is two hops out and is left alone", !saw("Cez"), JSON.stringify(checked));
  }

  // ---------- 2. a reply that only forgot its last brace ----------
  console.log("\n--- 2. a missing closing brace is not a failed check ---");
  {
    const { LF } = boot();
    const whole = JSON.stringify({ hasMultipleGenerations: true, generations: [{ code: "986", yearStart: 1996 }, { code: "982", yearStart: 2016 }] });
    const lost = whole.slice(0, -1);
    let got = null, err = null;
    try { got = LF.parseLlmJson(lost, { finishReason: "stop" }); } catch (e) { err = e; }
    check("the missing \"}\" is put back when the model said it had finished", got && got.generations.length === 2, err && err.message);
    err = null;
    try { LF.parseLlmJson(lost, { finishReason: "length" }); } catch (e) { err = e; }
    check("...but never for a reply cut off at the token ceiling", !!err && err.cutOff);
    err = null;
    try { LF.parseLlmJson('{"generations":[{"code":"98', { finishReason: "stop" }); } catch (e) { err = e; }
    check("...and never for one that stopped inside a value", !!err);
    err = null;
    try { LF.parseLlmJson('{"a":[[[[1', { finishReason: "stop" }); } catch (e) { err = e; }
    check("...or one with more than two brackets left open", !!err);
  }

  // ---------- 3. a generation's twin is folded in ----------
  console.log("\n--- 3. a plain car that is one of a nameplate's generations ---");
  {
    const fam = { id: "fam-twintest-boxster-and-cayman", type: "family", label: "Boxster and Cayman", make: "TwinTest",
                  year: 1996, end: 2025, generations: ["m-twintest-gen-986", "m-twintest-gen-982"], designers: [], engineers: [] };
    const nodesT = [
      { id: "mk-twintest", type: "make", label: "TwinTest", year: 1950 },
      fam,
      { id: "m-twintest-gen-986", type: "model", label: "Boxster and Cayman 986", make: "TwinTest", year: 1996, end: 2004, familyOf: fam.id },
      { id: "m-twintest-gen-982", type: "model", label: "Boxster and Cayman 982", make: "TwinTest", year: 2016, end: 2025, familyOf: fam.id },
      { id: "m-twintest-718-982", type: "model", label: "718 Boxster and Cayman (982)", make: "TwinTest", year: 2016, end: 2016,
        wp: "TwinTest 718 Boxster and Cayman (982)" },
      { id: "m-twintest-boxster-986", type: "model", label: "Boxster (986)", make: "TwinTest", year: 1996, end: 2004, wp: "TwinTest Boxster" },
      // Not a twin: the plain "Prius" is not the "Prius Plug-in Hybrid".
      { id: "fam-twintest-prius-phev", type: "family", label: "Prius Plug-in Hybrid", make: "TwinTest", year: 2012, end: null,
        generations: ["m-twintest-phev-xw60"], designers: [], engineers: [] },
      { id: "m-twintest-phev-xw60", type: "model", label: "Prius Plug-in Hybrid XW60", make: "TwinTest", year: 2023, end: null,
        familyOf: "fam-twintest-prius-phev" },
      { id: "m-twintest-prius-xw60", type: "model", label: "Prius (XW60)", make: "TwinTest", year: 2023, end: null, wp: "TwinTest Prius" },
    ];
    const linksT = nodesT.filter(n => n.type !== "make").map(n => ({ source: n.id, target: "mk-twintest", type: "made" }))
      .concat(nodesT.filter(n => n.familyOf).map(n => ({ source: n.familyOf, target: n.id, type: "generation" })));
    const { cw } = boot({ extraNodes: nodesT, extraLinks: linksT, store: {
      wpLinks: { "m-twintest-gen-982": "TwinTest 982" },
      wpRedirects: { "TwinTest 982": "TwinTest 718 Boxster and Cayman (982)" } } });
    const a = cw.byId.get("m-twintest-718-982"), b = cw.byId.get("m-twintest-boxster-986"), p = cw.byId.get("m-twintest-prius-xw60");
    check("the car whose article IS the 982's own article is folded into it",
      a.retired && a.supersededBy === "m-twintest-gen-982", a.supersededBy);
    check("\"Boxster (986)\" -- one half of the joined name, same code, same years -- is folded into the 986",
      b.retired && b.supersededBy === "m-twintest-gen-986", b.supersededBy);
    check("\"Prius (XW60)\" is not folded into the Prius Plug-in Hybrid's XW60", !p.retired, p.supersededBy);
  }

  // ---------- 4. also called ----------
  console.log("\n--- 4. \"also called\" ---");
  {
    const logan = fs.readFileSync(path.join(CACHE, "Dacia_Logan.wikitext"), "utf-8");
    const thor = fs.readFileSync(path.join(CACHE, "Daihatsu_Thor.wikitext"), "utf-8");
    const { cw, LF } = boot({ store: { aliases: { "m-akatest-logan": { names: ["Renault Symbol", "Renault Logan"] } } },
      extraNodes: [{ id: "mk-akatest", type: "make", label: "AkaTest", year: 1950 },
                   { id: "m-akatest-logan", type: "model", label: "Logan", make: "AkaTest", year: 2004, end: null }],
      extraLinks: [{ source: "m-akatest-logan", target: "mk-akatest", type: "made" }] });
    const lead = LF.akaNames(logan);
    check("the first infobox's names, links reduced to their text", lead.includes("Renault Logan") && lead.includes("Lada Largus (wagon, Russia)"), JSON.stringify(lead));
    check("a comma inside brackets does not split a name", lead.includes("Nissan NP200 (pick-up, South Africa)"), JSON.stringify(lead));
    check("only the first infobox: the second generation's names are not in it", !lead.includes("Renault Symbol"), JSON.stringify(lead));
    const second = logan.slice(logan.indexOf("Second generation") > 0 ? logan.indexOf("Second generation") : 0);
    const s2 = LF.akaNames(second);
    check("a section's own infobox gives its own names", s2[0] === "Renault Symbol" && s2.includes("Renault Logan"), JSON.stringify(s2));
    const t = LF.akaNames(thor);
    check("an {{unbulleted list}} becomes one name per line", JSON.stringify(t) === JSON.stringify(["Toyota Roomy", "Toyota Tank (2016–2020)", "Subaru Justy"]), JSON.stringify(t));
    const third = logan.slice(logan.indexOf("| aka = Renault Taliant"));
    const s3 = LF.akaNames(third);
    check("a commented-out name is left out", s3.includes("Renault Taliant (2021–present)") && !s3.some(x => /cancelled/.test(x)), JSON.stringify(s3));
    check("the car's own name is not listed as another name for it",
      !LF.akaNames("{{Infobox automobile\n| aka = Dacia Logan<br />Renault Symbol\n}}", "Dacia Logan").includes("Dacia Logan"));
    const n = cw.byId.get("m-akatest-logan");
    cw.openDetail(n);
    const meta = window.document.querySelector(".dt-meta").textContent;
    check("the card says what else it is called", /also called Renault Symbol · Renault Logan/.test(meta), meta);
    check("searching another market's name finds the car", cw.searchAll("renault symbol").some(x => x.id === n.id));
  }

  // ---------- 5. a nameplate's overview page is not one of its generations ----------
  console.log("\n--- 5. the overview page beside a nameplate ---");
  {
    const mk = (id, label, year, end, extra) => Object.assign({ id, type: "model", label, make: "UmbTest", year, end }, extra || {});
    const nodesU = [
      { id: "mk-umbtest", type: "make", label: "UmbTest", year: 1950 },
      { id: "fam-umbtest-roadster", type: "family", label: "Roadster", make: "UmbTest", year: 1996, end: null,
        generations: ["m-umbtest-roadster-r1", "m-umbtest-roadster-r2"], designers: [], engineers: [] },
      mk("m-umbtest-roadster-r1", "Roadster (R1)", 1996, 2004, { familyOf: "fam-umbtest-roadster" }),
      mk("m-umbtest-roadster-r2", "Roadster (R2)", 2005, null, { familyOf: "fam-umbtest-roadster" }),
      mk("m-umbtest-roadster", "Roadster", 1996, null, { wp: "UmbTest Roadster" }),
      { id: "fam-umbtest-coupe", type: "family", label: "Coupe", make: "UmbTest", year: 2005, end: null,
        generations: ["m-umbtest-coupe-c2"], designers: [], engineers: [] },
      mk("m-umbtest-coupe-c2", "Coupe (C2)", 2005, null, { familyOf: "fam-umbtest-coupe" }),
      mk("m-umbtest-coupe", "Coupe", 1972, 1973, { wp: "UmbTest Coupe" }),
    ];
    const linksU = nodesU.filter(n => n.type !== "make").map(n => ({ source: n.id, target: "mk-umbtest", type: "made" }))
      .concat(nodesU.filter(n => n.familyOf).map(n => ({ source: n.familyOf, target: n.id, type: "generation" })))
      .concat([{ source: "m-umbtest-roadster", target: "m-umbtest-roadster-r2", type: "succession" }]);
    const { cw } = boot({ extraNodes: nodesU, extraLinks: linksU });
    const fam = cw.byId.get("fam-umbtest-roadster"), over = cw.byId.get("m-umbtest-roadster");
    check("an overview page spanning the generations is folded into the nameplate, not listed as one",
      over.retired && over.supersededBy === fam.id && !fam.generations.includes(over.id), JSON.stringify(fam.generations));
    check("...and its link to one of the nameplate's own generations is not carried onto the nameplate",
      !cw.links.some(l => l.type === "succession" && !l.retired &&
        [l.source.id || l.source, l.target.id || l.target].sort().join() === [fam.id, "m-umbtest-roadster-r2"].sort().join()));
    const coupe = cw.byId.get("fam-umbtest-coupe"), early = cw.byId.get("m-umbtest-coupe");
    check("an overview page of an EARLIER era is still that era's generation",
      !early.retired && early.familyOf === coupe.id && coupe.generations[0] === early.id, JSON.stringify(coupe.generations));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
