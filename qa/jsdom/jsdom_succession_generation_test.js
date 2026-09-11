// "Succeeds" / "Succeeded by" resolved down to the specific generations it
// really describes.
//
// Real user request: "The 'Succeeds' and 'Succeeded by' information and the
// edge links should also be transferred to the generations of a nameplate.
// They should only revert to the nameplate itself if there is no proper
// reference to a specific generation. Currently the 'Succeeds' and
// 'Succeeded by' information is still connected directly at the nameplate
// level. Additionally, the 'Succeeds' and 'Succeeded by' should only appear
// either on a nameplate level or a generation of a nameplate level, but
// never double counted."
//
// Platform/related links have had a generation-level disambiguation flow for
// a while (checkRelation), but succession never did -- and it's the one
// relation type that needs no LLM call at all, because a succession is a
// statement about the ENDS of two production runs: the predecessor's LAST
// generation hands over to the successor's FIRST. llm_families.js's
// pushSuccessionToGenerations derives exactly that, and reuses the existing
// mirror precedence (linkInLayer) for the "never double counted" half.
//
// Four cases:
//   1. family -> family: both sides resolve (newest -> oldest).
//   2. family -> plain model: only the family side resolves; the plain model
//      "reverts to the nameplate itself" because it has no generations.
//   3. never both at once: the coarse nameplate link and the derived
//      generation link are never simultaneously visible.
//   4. a real LLM-resolved pair always wins -- no competing derived link.
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

function freshWindow(seed, llmSeed) {
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
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  seed(window.CARDATA);
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {}, __serverAvailable: false }, llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  load("platforms.js");
  return window;
}

// ---------- shared fixture ----------
// Old (2 generations) -> New (2 generations) -> a plain, never-split model.
const FAM_OLD = "fam-test-succ-old", O1 = "m-test-succ-o1", O2 = "m-test-succ-o2";
const FAM_NEW = "fam-test-succ-new", N1 = "m-test-succ-n1", N2 = "m-test-succ-n2";
const PLAIN = "m-test-succ-plain";
function seedBase(DATA) {
  const mk = { id: "mk-test-succ", type: "make", label: "TestSucc", year: 1950 };
  const famOld = { id: FAM_OLD, type: "family", label: "Olds", make: "TestSucc", year: 1980, end: 2000, generations: [O1, O2] };
  const o1 = { id: O1, type: "model", label: "Olds Mk1", make: "TestSucc", familyOf: FAM_OLD, year: 1980, end: 1990 };
  const o2 = { id: O2, type: "model", label: "Olds Mk2", make: "TestSucc", familyOf: FAM_OLD, year: 1990, end: 2000 };
  const famNew = { id: FAM_NEW, type: "family", label: "News", make: "TestSucc", year: 2000, end: null, generations: [N1, N2] };
  const n1 = { id: N1, type: "model", label: "News Mk1", make: "TestSucc", familyOf: FAM_NEW, year: 2000, end: 2012 };
  const n2 = { id: N2, type: "model", label: "News Mk2", make: "TestSucc", familyOf: FAM_NEW, year: 2012, end: null };
  const plain = { id: PLAIN, type: "model", label: "Plainy", make: "TestSucc", year: 2020, end: null };
  DATA.nodes.push(mk, famOld, o1, o2, famNew, n1, n2, plain);
  DATA.links.push(
    { source: FAM_OLD, target: mk.id, type: "made" }, { source: FAM_NEW, target: mk.id, type: "made" },
    { source: PLAIN, target: mk.id, type: "made" },
    { source: FAM_OLD, target: O1, type: "generation" }, { source: FAM_OLD, target: O2, type: "generation" },
    { source: FAM_NEW, target: N1, type: "generation" }, { source: FAM_NEW, target: N2, type: "generation" },
    { source: O1, target: O2, type: "gensucc" }, { source: N1, target: N2, type: "gensucc" },
    // The two coarse, nameplate-level succession facts this feature acts on.
    { source: FAM_OLD, target: FAM_NEW, type: "succession" },   // family -> family
    { source: FAM_NEW, target: PLAIN, type: "succession" },     // family -> plain model
  );
}

console.log("--- scenario 1: succession pushed down to the right generations ---");
{
  const window = freshWindow(seedBase);
  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);

  const idOf = v => (typeof v === "string" ? v : (v && v.id));
  const succ = (a, b) => cw.links.find(l => l.type === "succession" && !l.retired &&
    idOf(l.source) === a && idOf(l.target) === b);

  // Case 1: both sides are real nameplates -- the predecessor's NEWEST
  // generation hands over to the successor's OLDEST.
  const derived1 = succ(O2, N1);
  check("family->family: a derived succession Olds Mk2 -> News Mk1 was created", !!derived1);
  check("...tagged genLevel so it's distinguishable from a harvested link", derived1 && derived1.genLevel === true);
  check("it is NOT the wrong pair (oldest->oldest or newest->newest)", !succ(O1, N1) && !succ(O2, N2));

  // Case 2: the plain model has no generations, so it "reverts to the
  // nameplate itself" -- only the family side gets more specific.
  const derived2 = succ(N2, PLAIN);
  check("family->plain model: only the family side resolves (News Mk2 -> Plainy)", !!derived2);
  check("...and the plain model stayed itself, not invented into a generation",
    derived2 && cw.byId.get(idOf(derived2.target)).type === "model" && !cw.byId.get(idOf(derived2.target)).familyOf);

  // Case 3: never both at once. The original coarse link is tagged as a
  // mirror rather than removed, so it shows while collapsed and stands aside
  // once expanded -- exactly the precedence platform/related already use.
  const coarse = succ(FAM_OLD, FAM_NEW);
  check("the original nameplate-level link is still present (never deleted)", !!coarse);
  check("...but retroactively tagged as a mirror", coarse && coarse.mirror === true);
  const visible = () => [coarse, derived1].filter(l =>
    cw.linkInLayer(l) && cw.nodeInLayer(l.sn) && cw.nodeInLayer(l.tn)).length;
  check("COLLAPSED: exactly one of the two is visible (the nameplate-level one)", visible() === 1, visible());
  check("COLLAPSED: it's the coarse one", cw.linkInLayer(coarse) && !cw.nodeInLayer(derived1.sn));
  cw.expandFamily(FAM_OLD);
  cw.expandFamily(FAM_NEW);
  check("EXPANDED: still exactly one visible -- never double counted", visible() === 1, visible());
  check("EXPANDED: now it's the specific generation-level one", !cw.linkInLayer(coarse) && cw.linkInLayer(derived1));
  cw.collapseFamily(FAM_OLD);
  cw.collapseFamily(FAM_NEW);
  check("COLLAPSED AGAIN: back to exactly one, the coarse one", visible() === 1 && cw.linkInLayer(coarse));

  // The detail panel must agree with the graph -- a generation's own card
  // shows the succession now, which is the "information ... should also be
  // transferred to the generations" half of the request.
  cw.openDetail(cw.byId.get(O2));
  const conns = [...window.document.querySelectorAll(".dt-connections .dt-conn")].map(b => b.textContent.trim());
  const heads = [...window.document.querySelectorAll(".dt-connections h4")].map(h => h.textContent.trim());
  check("the newest OLD generation's card now says 'succeeded by'", heads.some(h => /succeeded by/i.test(h)), JSON.stringify(heads));
  check("...pointing at the oldest NEW generation", conns.some(t => t.includes("News Mk1")), JSON.stringify(conns));
}

console.log("\n--- scenario 2: an LLM-resolved pair wins; no competing derived link ---");
{
  // Same fixture, but with a confirmed relation entry that already pins the
  // succession to a DIFFERENT (deliberately non-default) generation pair.
  // The derived rollup must stand down entirely rather than adding a second,
  // contradictory line next to it.
  const key = [O1, N2].sort().join("|") + "|succession";
  const window = freshWindow(seedBase, {
    relations: {
      [key]: {
        status: "confirmed", famA: FAM_OLD, famB: FAM_NEW, relType: "succession",
        codeA: "Olds Mk1", codeB: "News Mk2", genIdA: O1, genIdB: N2,
        reason: "test fixture: an explicitly resolved, non-default pair",
      },
    },
  });
  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  const idOf = v => (typeof v === "string" ? v : (v && v.id));
  const between = (a, b) => cw.links.filter(l => l.type === "succession" && !l.retired &&
    ((idOf(l.source) === a && idOf(l.target) === b) || (idOf(l.source) === b && idOf(l.target) === a)));

  check("the LLM-resolved Olds Mk1 <-> News Mk2 link exists", between(O1, N2).length === 1, between(O1, N2).length);
  check("the default newest->oldest link was NOT also derived alongside it", between(O2, N1).length === 0, between(O2, N1).length);
  const specific = cw.links.filter(l => l.type === "succession" && !l.retired && !l.mirror &&
    [l.sn, l.tn].every(e => e && (e.familyOf === FAM_OLD || e.familyOf === FAM_NEW)));
  check("exactly ONE specific generation-level succession between these two nameplates", specific.length === 1, specific.length);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
