// Task #124 -- a designer/engineer's card must count and list each car ONCE,
// at its most specific level.
//
// Real user request (verbatim): "when I click on a designer or an engineer
// and it counts how many cars that a given person (or group) worked on, it
// should not count the nameplate of the car and then a generation of the
// nameplate separately. In the case where the person (or group) is
// associated with both, then it should only be counted once, and it should
// explicitly display only the generation of the nameplate of the car, not
// necessarily the nameplate itself. So, the count should be reflected as
// well as the list of cars that a particular person (or group) was
// associated with it. Naturally, if a nameplate doesn't have further info
// about who designed the generations but only has info on the nameplate
// itself, then fall back to the nameplate linking and have the person (or
// group) be associated and mentioned/counted towards the nameplate."
//
// The double count is created deliberately upstream and is correct there:
// build_family_layer.py (build time) and llm_families.js's applyConfirmed
// (runtime, its famPersonLinks rollup) both mirror the deduped set of
// generation-level designed/engineered credits UP onto the nameplate node,
// so a COLLAPSED nameplate still shows who drew it. linkInLayer already
// gives the generation-level line precedence in the graph once a family is
// expanded; the person's own card had no equivalent rule and read raw
// adjacency.
//
// Three cases are pinned down here:
//   A. credited on BOTH a nameplate and one of its generations -> counted
//      once, listed as the GENERATION.
//   B. credited only on a nameplate whose generations carry no credits ->
//      still counted, still listed, as the NAMEPLATE (the fallback).
//   C. the two roles are kept independent -- an engineer credit on the
//      nameplate and a designer credit on one of its generations are two
//      different facts and neither collapses the other away.
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

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window;
global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

// ---------- fixture ----------
const P = "p-test-cd-designer";          // credited on both a nameplate and its generation (case A)
const P2 = "p-test-cd-engineer";         // engineer on the nameplate, designer on a generation (case C)
const FAM = "fam-test-cd-alpha", G1 = "m-test-cd-alpha-g1", G2 = "m-test-cd-alpha-g2";
const FAM_B = "fam-test-cd-beta", B1 = "m-test-cd-beta-b1", B2 = "m-test-cd-beta-b2";

const DATA = window.CARDATA;
const mk = { id: "mk-test-cd", type: "make", label: "TestCredit", year: 1960 };
const person = { id: P, type: "person", kind: "person", label: "Testy Drawer", roles: ["designer"], born: 1950, country: "Testland" };
const person2 = { id: P2, type: "person", kind: "person", label: "Testy Builder", roles: ["designer", "engineer"], born: 1955, country: "Testland" };

// Nameplate A: person IS credited on a specific generation, so the
// family-level mirror is the redundant one.
const famA = { id: FAM, type: "family", label: "Alpha", make: "TestCredit", year: 2000, end: null,
  generations: [G1, G2], designers: ["Testy Drawer"], engineers: ["Testy Builder"] };
const g1 = { id: G1, type: "model", label: "Alpha G1", make: "TestCredit", familyOf: FAM, year: 2000, end: 2010, designers: ["Testy Drawer"] };
const g2 = { id: G2, type: "model", label: "Alpha G2", make: "TestCredit", familyOf: FAM, year: 2010, end: null, designers: [], engineers: [] };

// Nameplate B: person is credited ONLY at the nameplate level -- nothing more
// specific exists, so this must survive the collapse untouched.
const famB = { id: FAM_B, type: "family", label: "Beta", make: "TestCredit", year: 1990, end: null,
  generations: [B1, B2], designers: ["Testy Drawer"] };
const b1 = { id: B1, type: "model", label: "Beta B1", make: "TestCredit", familyOf: FAM_B, year: 1990, end: 2000 };
const b2 = { id: B2, type: "model", label: "Beta B2", make: "TestCredit", familyOf: FAM_B, year: 2000, end: null };

DATA.nodes.push(mk, person, person2, famA, g1, g2, famB, b1, b2);
DATA.links.push(
  { source: FAM, target: mk.id, type: "made" }, { source: FAM_B, target: mk.id, type: "made" },
  { source: FAM, target: G1, type: "generation" }, { source: FAM, target: G2, type: "generation" },
  { source: FAM_B, target: B1, type: "generation" }, { source: FAM_B, target: B2, type: "generation" },
  // Case A: BOTH the generation-level credit and its family-level mirror.
  { source: G1, target: P, type: "designed" },
  { source: FAM, target: P, type: "designed" },
  // Case B: nameplate-level only -- no generation of Beta credits anyone.
  { source: FAM_B, target: P, type: "designed" },
  // Case C: different roles on the two levels; neither may swallow the other.
  { source: FAM, target: P2, type: "engineered" },
  { source: G1, target: P2, type: "designed" },
);

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
loadScript("platforms.js");

const cw = window.CarWeb;
cw.boot();
cw.setLayer("both");                       // both roles visible, so nothing is filtered by the layer toggle
cw.setYearRange(1900, cw.yearRange().max); // and nothing by the year slider either

const pNode = cw.byId.get(P);
const p2Node = cw.byId.get(P2);
check("fixture: designer node exists", !!pNode);
// Compared via .sn/.tn (the node refs app.js resolves itself) rather than
// .source/.target -- d3-force's forceLink mutates those from id strings into
// node object references the moment buildSim() runs, which boot() above has
// already done.
check("fixture: the family-level mirror AND the generation-level credit both exist in the data",
  cw.links.some(l => l.type === "designed" && l.sn && l.sn.id === FAM && l.tn && l.tn.id === P) &&
  cw.links.some(l => l.type === "designed" && l.sn && l.sn.id === G1 && l.tn && l.tn.id === P));

// ---------- the count on the hover card / detail meta line ----------
// Raw adjacency is 3 designed-links (Alpha family, Alpha G1, Beta family);
// the correct count is 2 CARS (Alpha G1 + Beta), because Alpha must not be
// counted at both levels.
const rawDegree = cw.adj.get(P).filter(a => a.l.type === "designed").length;
check("fixture: raw adjacency really does contain the double count", rawDegree === 3, rawDegree);
const meta = cw.nodeMeta(pNode);
check("count says 2 cars, not 3 -- the nameplate and its own generation are one car", /\b2 cars\b/.test(meta), meta);

// ---------- the connections list in the detail panel ----------
cw.openDetail(pNode);
const conns = [...window.document.querySelectorAll(".dt-connections .dt-conn")].map(b => b.textContent.trim());
check("exactly 2 cars listed", conns.length === 2, JSON.stringify(conns));
check("case A: the GENERATION is what's shown", conns.some(t => t.includes("Alpha G1")), JSON.stringify(conns));
check("case A: the bare nameplate is NOT also listed", !conns.some(t => /TestCredit Alpha\b(?! G)/.test(t)), JSON.stringify(conns));
check("case B: a nameplate with no generation-level credit still falls back to the nameplate",
  conns.some(t => t.includes("Beta")), JSON.stringify(conns));
check("case B: it's the nameplate itself, not one of its generations",
  !conns.some(t => /Beta B[12]/.test(t)), JSON.stringify(conns));

// ---------- roles stay independent ----------
cw.openDetail(p2Node);
const headings = [...window.document.querySelectorAll(".dt-connections h4")].map(h => h.textContent.trim());
const conns2 = [...window.document.querySelectorAll(".dt-connections .dt-conn")].map(b => b.textContent.trim());
check("case C: both an 'engineered' and a 'designed' grouping are shown",
  headings.some(h => /engineer/i.test(h)) && headings.some(h => /drawn|design/i.test(h)), JSON.stringify(headings));
check("case C: the nameplate-level ENGINEER credit survives (a designer credit on a generation doesn't erase it)",
  conns2.some(t => /TestCredit Alpha\b(?! G)/.test(t)), JSON.stringify(conns2));
check("case C: the generation-level DESIGNER credit is there too", conns2.some(t => t.includes("Alpha G1")), JSON.stringify(conns2));
// Two rows, two distinct facts, but only ONE car. The list keeps both
// (dropping a real nameplate-level engineer credit because an unrelated
// designer credit exists on a generation would lose information); the COUNT
// collapses them, because "how many cars did this person work on" is a
// question about cars, not about credits. See nodeMeta's own comment.
const meta2 = cw.nodeMeta(p2Node);
check("case C: the count is 1 car (same car line, two roles), not 2", /\b1 car\b/.test(meta2), meta2);

// ---------- expanding/collapsing must not change any of it ----------
// The graph's own linkInLayer precedence is expansion-sensitive by design;
// the person's card deliberately is NOT, since a card shows facts about a
// person rather than a snapshot of the current viewport.
cw.expandFamily(FAM);
check("expanded: count unchanged", /\b2 cars\b/.test(cw.nodeMeta(pNode)), cw.nodeMeta(pNode));
cw.collapseFamily(FAM);
check("collapsed again: count unchanged", /\b2 cars\b/.test(cw.nodeMeta(pNode)), cw.nodeMeta(pNode));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
