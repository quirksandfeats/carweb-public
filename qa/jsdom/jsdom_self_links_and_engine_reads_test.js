// Two reports, one file.
//
// 1. "For the mercedes e class, isn't the succession link to the w114 correct?"
//    The chain was. What was wrong sat beside it: the W114/W115 stored as
//    "succeeded by" itself and "related to" itself, and nameplates drawn as
//    sharing a platform with their own generations. A relation needs two
//    cars; one between a car and itself is never drawn.
//
// 2. "I noticed an issue with the Mercedes-Benz M176/M177/M178 engine. When I
//    scanned the main engine, not the engine vars, it produced many copies."
//    Two reads of the same article were on file -- an old one under the M177,
//    which had taken its sibling engines for variants, and the page's own --
//    and both were applied. A read whose engine was merged into one that has
//    its own read is not replayed; a fresh read retires the variants it no
//    longer lists; and a single-code engine merged into the page that names
//    it becomes THAT code's variant, not a second one beside it.
//
// 3. "I would like to resolve redirects and merge automatically. But ...
//    engines like the 'M177 Evo' are truly different enginevars of that
//    family, so this is EXTREMELY important to keep. In any case, if the
//    engine has any different text than the other engines on the list, then
//    it's very likely that they are indeed different engines."
//    Two engine nodes that are one article are merged, and what the one
//    folded in becomes is decided by its name: the same name is the same
//    engine, any other name is a variant kept under that name.
//
// 4. A re-check of the Mercedes-Benz C-Class came back with the W201 as its
//    first generation. "If the wikipedia page mentions that the W201 is a
//    predecessor, then that's what we should prioritize. Wikipedia will state
//    this." A car the article files under "Predecessor models", or names as
//    the predecessor in the nameplate's own infobox, is not a generation.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
function load(store) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const w = dom.window;
  w.LLM_FAMILIES = store || {};
  // The only network there is: Wikipedia's answer to "which of these titles
  // are redirects", from the table a section sets.
  w.fetch = url => {
    const u = String(url);
    if (/action=query&redirects=1/.test(u)) {
      const titles = decodeURIComponent(u.split("titles=")[1] || "").split("|");
      return Promise.resolve({ ok: true, json: async () => ({ query: {
        redirects: titles.filter(t => REDIRECTS[t]).map(t => ({ from: t, to: REDIRECTS[t] })) } }) });
    }
    const page = u.match(/[?&]page=([^&]+)/);
    if (page && ARTICLES[decodeURIComponent(page[1]).replace(/_/g, " ")]) {
      const title = decodeURIComponent(page[1]).replace(/_/g, " ");
      return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": ARTICLES[title] } } }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }), text: async () => "" });
  };
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return w.LlmFamilies;
}
const idOf = v => (typeof v === "string" ? v : v.id);
let REDIRECTS = {};
const ARTICLES = {};

// ---------- 1. nothing is related to itself ----------
{
  const LF = load({});
  const nodes = [
    { id: "fam-e", type: "family", label: "E-Class", make: "M", generations: ["e-w114", "e-w123"] },
    { id: "e-w114", type: "model", label: "E-Class W114", make: "M", familyOf: "fam-e", year: 1968 },
    { id: "e-w123", type: "model", label: "E-Class W123", make: "M", familyOf: "fam-e", year: 1975 },
    { id: "m-other", type: "model", label: "Other", make: "M", year: 1970 },
  ];
  const links = [
    { source: "e-w114", target: "e-w114", type: "succession" },   // itself
    { source: "e-w114", target: "e-w114", type: "related" },
    { source: "e-w123", target: "fam-e", type: "platform" },      // its own nameplate
    { source: "fam-e", target: "fam-e", type: "platform", mirror: true },
    { source: "e-w114", target: "e-w123", type: "related" },      // two generations: a real statement
    { source: "e-w123", target: "m-other", type: "platform" },
    { source: "fam-e", target: "e-w114", type: "generation" },    // structure, not a relation
  ];
  const n = LF.retireSelfLinks(nodes, links);
  const live = links.filter(l => !l.retired).map(l => l.type + ":" + idOf(l.source) + ">" + idOf(l.target));
  check("the four relations between a car and itself are retired", n === 4, n);
  check("...and nothing else is touched",
    JSON.stringify(live) === JSON.stringify(["related:e-w114>e-w123", "platform:e-w123>m-other", "generation:fam-e>e-w114"]),
    live.join(", "));
  check("...including on a second pass", LF.retireSelfLinks(nodes, links) === 0);
}

// ---------- 2. one article, two reads on file ----------
{
  const PAGE = "eng-mercedes-benz-m176-m177-m178", OLD = "eng-mercedes-benz-m177";
  const TITLE = "Mercedes-Benz M176/M177/M178 engine";
  const read = (shortName, codes) => ({
    status: "confirmed", checkedAt: "2026-01-01T00:00:00.000Z", sourceTitle: TITLE, resolved: [],
    article: { name: "Mercedes-Benz M176/M177/M178", shortName, standalone: false, applications: [],
               variants: codes.map(code => ({ code, applications: [] })) },
  });
  const store = {
    engines: {
      [OLD]: read("M177 Evo", ["M177 Evo M176", "M177 Evo M177", "M177 Evo M178"]),   // the old, wrong read
      [PAGE]: read("M176/M177/M178", ["M176", "M177", "M178"]),                        // the page's own
    },
    engineMerges: { [PAGE]: { memberIds: [OLD, "eng-mercedes-benz-m178"], mergedAt: "2026-01-02T00:00:00.000Z" } },
    engineScans: {
      "car-a": { status: "confirmed", v: 99, engines: [{ title: "Mercedes-Benz M177 engine", name: "M177 Evo", said: "4.0 L M177 Evo V8", specs: { displacement: "4.0 L" } }] },
      "car-b": { status: "confirmed", v: 99, engines: [{ title: "Mercedes-Benz M178 engine", name: "M177", said: "4.0 L M177 twin-turbo V8", specs: { displacement: "4.0 L" } }] },
      "car-c": { status: "confirmed", v: 99, engines: [{ title: "Mercedes-Benz M178 engine", name: "M178", said: "4.0 L M178 V8", specs: { displacement: "4.0 L" } }] },
    },
    wpRedirects: { "Mercedes-Benz M177 engine": TITLE },
  };
  const LF = load(store);
  const nodes = ["car-a", "car-b", "car-c"].map(id => ({ id, type: "model", label: id, make: "M", year: 2020 }));
  const links = [];
  LF.applyEngines(nodes, links);
  LF.applyEngineMentions(nodes, links);
  LF.applyEngineMerges(nodes, links);
  LF.tidyPowertrain(nodes, links);
  LF.tidyEngineLinks(nodes, links);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const page = byId.get(PAGE);
  const vars = nodes.filter(n => n.type === "enginevar" && !n.retired && n.engineOf === PAGE).map(n => n.label).sort();
  check("the page is one engine with one variant per code, once each -- and the M177 Evo, which is its own",
    JSON.stringify(vars) === JSON.stringify(["M176", "M177", "M177 Evo", "M178"]), vars.join(", "));
  const liveEngines = nodes.filter(n => n.type === "engine" && !n.retired).map(n => n.id);
  check("...and no second engine node beside it", JSON.stringify(liveEngines) === JSON.stringify([PAGE]), liveEngines.join(", "));
  const on = car => links.filter(l => l.type === "fitted" && !l.retired && (idOf(l.source) === car || idOf(l.target) === car))
    .map(l => (byId.get(idOf(l.source) === car ? idOf(l.target) : idOf(l.source)) || {}).label);
  check("a car whose link called it the M177 Evo is on the M177 Evo", JSON.stringify(on("car-a")) === JSON.stringify(["M177 Evo"]), on("car-a").join(", "));
  check("a car that linked the M178's title but SAID M177 is on the M177", JSON.stringify(on("car-b")) === JSON.stringify(["M177"]), on("car-b").join(", "));
  check("a car that said M178 is on the M178", JSON.stringify(on("car-c")) === JSON.stringify(["M178"]), on("car-c").join(", "));
  check("the engine's card has a read to show", !!LF.engineEntryFor(PAGE));
  check("(sanity) the page node kept its own name", page && page.label === "Mercedes-Benz M176/M177/M178", page && page.label);
}

// ---------- 3. a car twice on one variant ----------
{
  const LF = load({});
  const nodes = [
    { id: "eng-x", type: "engine", label: "X", variants: ["engv-x-a"] },
    { id: "engv-x-a", type: "enginevar", label: "A", engineOf: "eng-x" },
    { id: "car-1", type: "model", label: "One", make: "M" },
    { id: "car-2", type: "model", label: "Two", make: "M" },
  ];
  const links = [
    { source: "engv-x-a", target: "car-1", type: "fitted" },                                   // from the article's table
    { source: "engv-x-a", target: "car-1", type: "fitted", fromCar: true, saidText: "2.0 L A I4", saidSpecs: { displacement: "2.0 L" } },
    { source: "engv-x-a", target: "car-2", type: "fitted", fromCar: true, saidText: "1.6 L A I4", saidSpecs: { displacement: "1.6 L" } },
    { source: "engv-x-a", target: "car-2", type: "fitted", fromCar: true, saidText: "2.0 L A I4", saidSpecs: { displacement: "2.0 L" } },
  ];
  LF.tidyEngineLinks(nodes, links);
  const lines = car => links.filter(l => !l.retired && idOf(l.target) === car).map(l => l.saidText || "(bare)");
  check("the bare table edge goes when the car has said it in its own words",
    JSON.stringify(lines("car-1")) === JSON.stringify(["2.0 L A I4"]), lines("car-1").join(" | "));
  check("two different lines on one variant are two engines and both stay",
    lines("car-2").length === 2, lines("car-2").join(" | "));
}

// ---------- 4. one article under two titles ----------
(async () => {
  const store = {
    __serverAvailable: true,
    engineScans: {
      "car-1": { status: "confirmed", v: 99, engines: [
        { title: "GM Family 1 engine", name: "Family 1", said: "1.6 L Family 1 I4", specs: { displacement: "1.6 L" } },
        { title: "Family 1 engine", name: "Family 1", said: "1.4 L Family 1 I4", specs: { displacement: "1.4 L" } },
        { title: "X14XE", name: "X14XE", said: "1.4 L X14XE I4", specs: { displacement: "1.4 L" } },
        { title: "BMW B58", name: "B58", said: "3.0 L B58 I6", specs: { displacement: "3.0 L" } },
        { title: "BMW S58", name: "S58", said: "3.0 L S58 I6", specs: { displacement: "3.0 L" } },
        { title: "Honda K engine", name: "Honda K", said: "2.0 L K20 I4", specs: { displacement: "2.0 L" } },
      ] },
    },
  };
  const LF = load(store);
  const nodes = [{ id: "car-1", type: "model", label: "One", make: "M", year: 2020 }];
  const links = [];
  LF.applyEngineMentions(nodes, links);
  const liveEngines = () => nodes.filter(n => n.type === "engine" && !n.retired).map(n => n.label).sort();
  check("(precondition) with no redirect known, each title is its own engine", liveEngines().length === 6, liveEngines().join(", "));

  REDIRECTS = { "Family 1 engine": "GM Family 1 engine", "X14XE": "GM Family 1 engine", "BMW S58": "BMW B58" };
  const res = await LF.resolveEngineTitleRedirects(nodes, links);
  check("the redirects are learned from one cheap question", res.learned === 3 && res.asked === 6, JSON.stringify(res));
  check("three nodes are left, one per article", liveEngines().length === 3, liveEngines().join(", "));
  const fam1 = nodes.filter(n => n.type === "engine" && !n.retired && /Family 1/.test(n.label));
  check("an engine under another spelling of its name is the same engine -- one node, on the article's own title, and no variant",
    fam1.length === 1 && fam1[0].id === "eng-gm-family-1" &&
    !nodes.some(n => n.type === "enginevar" && !n.retired && /Family 1/.test(n.label)),
    fam1.map(n => n.id).join(", "));
  const variantsOf = id => nodes.filter(n => n.type === "enginevar" && !n.retired && n.engineOf === id).map(n => n.label).sort();
  check("an engine with a name of its own is kept, as a variant under that name (X14XE)",
    JSON.stringify(variantsOf("eng-gm-family-1")) === JSON.stringify(["X14XE"]), variantsOf("eng-gm-family-1").join(", "));
  check("...and so is the S58 on the B58's page",
    JSON.stringify(variantsOf("eng-bmw-b58")) === JSON.stringify(["S58"]), variantsOf("eng-bmw-b58").join(", "));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const lines = links.filter(l => l.type === "fitted" && !l.retired)
    .map(l => (byId.get(idOf(l.source)) || {}).label + " :: " + l.saidText).sort();
  check("no line of the car's is lost by any of it", lines.length === 6, lines.join(" | "));
  check("...the two Family 1 lines on the one engine, the X14XE on its variant",
    lines.some(x => / :: 1\.6 L Family 1 I4$/.test(x) && !/^X14XE/.test(x)) &&
    lines.some(x => / :: 1\.4 L Family 1 I4$/.test(x) && !/^X14XE/.test(x)) &&
    lines.includes("X14XE :: 1.4 L X14XE I4"), lines.join(" | "));
  const again = await LF.resolveEngineTitleRedirects(nodes, links);
  check("a title is asked about once", again.asked === 0, JSON.stringify(again));

  // ---------- 5. what the article calls a predecessor ----------
  const body = (code, y) => `The ${code} was introduced in ${y}. `.repeat(12);
  ARTICLES["Testmarque Cee"] = `{{Infobox automobile
| name = Testmarque Cee
| production = 1992-present
| predecessor = [[Testmarque P201|Testmarque 190 (P201)]]
}}
The Testmarque Cee replaced the 190 (P201) range in 1992.

== Predecessor models ==
=== P201 (1982) ===
{{Infobox automobile
| name = P201
| production = 1982-1993
}}
${body("P201", 1982)}

== First generation (C202; 1992) ==
${body("C202", 1992)}

== Second generation (C203; 2000) ==
${body("C203", 2000)}
`;
  ARTICLES["Testmarque Dee"] = `{{Infobox automobile
| name = Testmarque Dee
| predecessor = [[Testmarque Q9]]
}}
The Testmarque Dee followed the Q9.

== Q9 (1970) ==
${body("Q9", 1970)}

== D1 (1980) ==
${body("D1", 1980)}

== D2 (1990) ==
${body("D2", 1990)}
`;
  ARTICLES["Testmarque Eee"] = `{{Infobox automobile
| name = Second generation (E2)
| production = 2010-present
| predecessor = Testmarque Eee (E1)
}}
The Testmarque Eee is in its second generation.

== E1 (2000) ==
${body("E1", 2000)}

== E2 (2010) ==
${body("E2", 2010)}
`;
  const gen = (code, y0) => ({ code, yearStart: y0, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] });
  const LF2 = load({ __serverAvailable: true });
  const run = async (wp, gens) => (await LF2.previewNodeResult({ id: "m-" + wp, type: "model", label: wp, make: "Testmarque", wp }, { hasMultipleGenerations: true, generations: gens })).clean;
  const cee = await run("Testmarque Cee", [gen("P201", 1982), gen("C202", 1992), gen("C203", 2000)]);
  check("a car filed under 'Predecessor models' is not a generation",
    JSON.stringify(cee.generations.map(g => g.code)) === JSON.stringify(["C202", "C203"]), cee.generations.map(g => g.code).join(", "));
  check("...and the result says why it was set aside",
    (cee.predecessors || []).length === 1 && cee.predecessors[0].code === "P201" && /Predecessor models/.test(cee.predecessors[0].why),
    JSON.stringify(cee.predecessors));
  const dee = await run("Testmarque Dee", [gen("Q9", 1970), gen("D1", 1980), gen("D2", 1990)]);
  check("nor is the oldest entry when the nameplate's own infobox names it as the predecessor",
    JSON.stringify(dee.generations.map(g => g.code)) === JSON.stringify(["D1", "D2"]), dee.generations.map(g => g.code).join(", "));
  const eee = await run("Testmarque Eee", [gen("E1", 2000), gen("E2", 2010)]);
  check("a GENERATION's own infobox naming the generation before it changes nothing",
    JSON.stringify(eee.generations.map(g => g.code)) === JSON.stringify(["E1", "E2"]), eee.generations.map(g => g.code).join(", "));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
