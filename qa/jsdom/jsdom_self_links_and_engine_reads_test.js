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
  w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => "" });
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return w.LlmFamilies;
}
const idOf = v => (typeof v === "string" ? v : v.id);

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
  check("the page is one engine with one variant per code, once each",
    JSON.stringify(vars) === JSON.stringify(["M176", "M177", "M178"]), vars.join(", "));
  const liveEngines = nodes.filter(n => n.type === "engine" && !n.retired).map(n => n.id);
  check("...and no second engine node beside it", JSON.stringify(liveEngines) === JSON.stringify([PAGE]), liveEngines.join(", "));
  const on = car => links.filter(l => l.type === "fitted" && !l.retired && (idOf(l.source) === car || idOf(l.target) === car))
    .map(l => (byId.get(idOf(l.source) === car ? idOf(l.target) : idOf(l.source)) || {}).label);
  check("a car whose link named the M177 is on the M177", JSON.stringify(on("car-a")) === JSON.stringify(["M177"]), on("car-a").join(", "));
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

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
