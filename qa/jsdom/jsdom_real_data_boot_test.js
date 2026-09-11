// End-to-end smoke test against the REAL dataset -- no synthetic fixture, no
// stubbed store. Boots app.js + llm_families.js over the actual baked
// data.js AND the actual llm_families.json currently on disk, then exercises
// the interactions most likely to break.
//
// Every other file in this suite constructs a small, controlled fixture,
// which is right for pinning down one behaviour precisely -- but it means a
// change can be provably correct on eight synthetic nodes and still fall over
// on 6,800 real ones with their genuinely messy shapes (missing years,
// retired standalones, families whose links live on generations, cars with no
// Wikipedia link at all). This is the counterweight: it asserts very little
// about any specific car, and a lot about "the whole thing still comes up and
// nothing throws".
//
// Deliberately runs with `__serverAvailable: false` -- this is about the
// boot/replay/render path over real data, not about the LLM layer's live
// behaviour, which every other file covers.
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
window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window;
global.document = window.document;
const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
load("d3.min.js");
load("data.js");
// The real, current on-disk LLM layer -- every confirmed split, override,
// resolved relation, merge and pasted link Andy has actually accumulated.
window.LLM_FAMILIES = Object.assign(
  JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8")),
  { __serverAvailable: false });
load("llm_families.js");
load("app.js");
load("timeline.js");
load("sixdeg.js");
load("platforms.js");

const cw = window.CarWeb;
let bootError = null;
try { cw.boot(); } catch (e) { bootError = e; }
check("the whole boot sequence runs clean over the real dataset", !bootError, bootError && bootError.stack);
const counts = window.document.getElementById("counts").textContent;
check("footer counts were computed", /\d+ models/.test(counts), counts);

// ---------- succession rollup, over real data ----------
const derived = cw.links.filter(l => l.type === "succession" && l.genLevel);
// Whether ANY link needs pushing down is genuinely data-dependent, so this
// asserts the conditional rather than a raw count. A BUILD-TIME family's
// succession links are already at generation level (they were harvested onto
// the specific generation's own article, and build_family_layer.py's
// mirror_relation_links added the family-level stand-in) -- there's nothing
// to derive there, and the rollup correctly skips anything already tagged
// `mirror`. It's LLM-created families, whose generations are minted fresh
// with only a family-level succession link, that need it. So: if there are
// eligible links, some must have been derived; if there are none, deriving
// nothing is the right answer, not a failure.
const eligible = cw.links.filter(l => l.type === "succession" && !l.mirror && !l.retired && !l.genLevel &&
  l.sn && l.tn && (l.sn.type === "family" || l.tn.type === "family"));
check("succession is pushed down whenever there is anything to push down",
  eligible.length === 0 || derived.length > 0, `${derived.length} derived from ${eligible.length} eligible`);
check("every derived succession link connects two live, resolvable nodes",
  derived.every(l => l.sn && l.tn && !l.sn.retired && !l.tn.retired), derived.length);
check("...and never connects a node to itself", derived.every(l => l.sn !== l.tn));
check("...and never links two generations of the SAME nameplate (that's what gensucc is for)",
  derived.every(l => !(l.sn.familyOf && l.sn.familyOf === l.tn.familyOf)));

// "Never double counted": a COARSE nameplate-level line and a SPECIFIC
// generation-level line for the same nameplate pair must never both draw.
// (Two DIFFERENT specific generation pairs between the same two nameplates is
// a separate, legitimate thing and is not what this checks.) Indexed by pair
// rather than nested-scanned -- ~19k links squared is far too slow.
const idOf = v => (typeof v === "string" ? v : (v && v.id));
const famOf = n => (n && (n.familyOf || n.id)) || null;
const byPair = new Map();
cw.links.forEach(l => {
  if (l.type !== "succession" || l.retired || !l.sn || !l.tn) return;
  const a = famOf(l.sn), b = famOf(l.tn);
  if (!a || !b) return;
  const k = [a, b].sort().join("|");
  if (!byPair.has(k)) byPair.set(k, []);
  byPair.get(k).push(l);
});
let doubled = 0;
const examples = [];
byPair.forEach((ls, k) => {
  const vis = ls.filter(o => cw.linkInLayer(o) && cw.nodeInLayer(o.sn) && cw.nodeInLayer(o.tn));
  const coarse = vis.filter(o => o.mirror), specific = vis.filter(o => !o.mirror);
  if (coarse.length && specific.length) {
    doubled++;
    if (examples.length < 5) examples.push(k);
  }
});
check("no succession pair draws at BOTH the nameplate and generation level at once", doubled === 0,
  doubled + (examples.length ? " e.g. " + examples.join(", ") : ""));

// ---------- the interactions the new focus/reveal code paths run through ----------
cw.setYearRange(2000, cw.yearRange().max); // back to the shipped default first
const realFamilies = cw.nodes.filter(n => n.type === "family" && !n.retired).slice(0, 12);
check("the real dataset has nameplates to focus (precondition)", realFamilies.length > 0, realFamilies.length);
let focusError = null;
try {
  realFamilies.forEach(f => { cw.goto(f.id); if (!cw.graphFocusSet()) throw new Error("no focus set for " + f.id); });
} catch (e) { focusError = e; }
check("focusing a dozen real nameplates never throws (reveal + fly-to over messy real links)",
  !focusError, focusError && focusError.stack);

const bigMakes = cw.nodes.filter(n => n.type === "make").sort((a, b) => b.deg - a.deg).slice(0, 5);
let makeError = null, widened = false;
try {
  bigMakes.forEach(m => {
    const before = cw.yearRange();
    cw.goto(m.id);
    const after = cw.yearRange();
    if (after.lo < before.lo || after.hi > before.hi) widened = true;
  });
} catch (e) { makeError = e; }
check("focusing the five biggest makes never throws", !makeError, makeError && makeError.stack);
check("...and clicking a make widens the year range to cover its own models", widened,
  JSON.stringify(cw.yearRange()));

// ---------- person cards, over real people ----------
const people = cw.nodes.filter(n => n.type === "person" && !n.retired && n.deg >= 4).slice(0, 40);
check("the real dataset has well-connected people to check (precondition)", people.length > 0, people.length);
let personError = null, anyDeduped = false;
try {
  people.forEach(p => {
    const meta = cw.nodeMeta(p);
    if (!/\d+ cars?\b/.test(meta)) throw new Error("no car count in meta for " + p.label + ": " + meta);
    // Raw adjacency vs the deduped count: at least one real person somewhere
    // in this dataset must actually BE affected, or the fix is untested here.
    const raw = new Set((cw.adj.get(p.id) || [])
      .filter(a => (a.l.type === "designed" || a.l.type === "engineered") && !a.l.retired && a.n && !a.n.retired)
      .map(a => a.n.id)).size;
    const shown = parseInt(meta.match(/(\d+) cars?\b/)[1], 10);
    if (shown < raw) anyDeduped = true;
    if (shown > raw) throw new Error("deduped count exceeded raw adjacency for " + p.label);
    cw.openDetail(p);
  });
} catch (e) { personError = e; }
check("every real person's card renders and counts sanely", !personError, personError && personError.stack);
check("...and the dedup genuinely fires on real data (some person really was double-counted before)",
  anyDeduped);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
