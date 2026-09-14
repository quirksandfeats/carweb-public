// Real user question, about rebuilding often: "would there be an issue with the
// cars that were created with the LLM or by hand in this case?"
//
// Mostly no. Node ids come from make and label, so a rebuild reproduces them,
// and everything in the LLM store is replayed over the new bake. The one way
// work detaches is when a car's identity moves under it -- DBpedia renames the
// article or changes the manufacturer, the id changes with it, and every
// decision pointing at the old id is aimed at nothing.
//
// And nothing breaks when that happens, which is exactly the problem: the
// split simply never applies, a relation with a missing end is skipped, a patch
// is pruned. So a nameplate you split quietly goes back to being one model and
// the entry sits in the file doing nothing. This is the count that makes a
// rebuild's drift visible.
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
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function load(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
load("d3.min.js");
load("data.js");

const DATA = window.CARDATA;
const MK = "mk-test-orph";
DATA.nodes.push({ id: MK, type: "make", label: "TestOrph", year: 1950 });
// A car that IS still in the graph -- its decisions must not be reported.
DATA.nodes.push({ id: "m-test-orph-present", type: "model", label: "Present", make: "TestOrph",
                  wp: "TestOrph Present", year: 2000, end: null, designers: [] });
DATA.links.push({ source: "m-test-orph-present", target: MK, type: "made" });

// A store full of decisions, half of them aimed at cars that no longer exist
// -- which is what a rebuild that renamed those cars upstream leaves behind.
const GONE = "m-test-orph-vanished", GONE2 = "m-test-orph-vanished-two";
window.LLM_FAMILIES = {
  __serverAvailable: false,
  families: {
    [GONE]: { status: "confirmed", proposal: { generations: [] } },
    "m-test-orph-present": { status: "confirmed", proposal: { generations: [] } },
  },
  recheck: { [GONE]: { status: "provisional" } },
  wpLinks: { [GONE2]: "TestOrph Vanished Two", "m-test-orph-present": "TestOrph Present" },
  genResearch: { [GONE]: { status: "done" } },
  merges: { [GONE]: { label: "TestOrph Vanished" } },
  renames: { [GONE2]: { label: "New Name", previousLabel: "Old Name", kind: "model" } },
  unmerges: { [GONE]: { at: "2026-01-01" } },
  relations: {
    // One end gone.
    "a|b|platform": { status: "confirmed", famA: GONE, famB: "m-test-orph-present",
                      relType: "platform" },
    // Both ends present -- must NOT be reported.
    "c|d|platform": { status: "confirmed", famA: "m-test-orph-present",
                      famB: "m-test-orph-present", relType: "platform" },
  },
  // Excluded on purpose: a deletion whose car is gone has got what it wanted,
  // and reporting it would bury the real ones.
  deletions: { [GONE]: { kind: "model", label: "TestOrph Vanished", cascadeIds: [] } },
  purged: { [GONE]: true },
};
load("llm_families.js");
load("app.js");
load("timeline.js");
load("sixdeg.js");

const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;

const items = LF.orphanedEntries(cw.byId);
const buckets = items.map(i => i.bucket).sort();

check("every bucket where an orphan means a decision stopped applying is checked",
      ["families", "genResearch", "merges", "recheck", "relations", "renames", "unmerges", "wpLinks"]
        .every(b => buckets.includes(b)), buckets.join(", "));
check("a decision about a car that IS still here is not reported",
      !items.some(i => i.id === "m-test-orph-present" || i.id === "c|d|platform"),
      items.filter(i => /present|c\|d/.test(i.id)).map(i => i.bucket).join(", "));
check("a relation is reported when EITHER end is gone",
      items.some(i => i.bucket === "relations" && i.id === "a|b|platform"));
check("...and named in terms of both cars, so it can be recognised",
      items.some(i => i.bucket === "relations" && /TestOrph Present/.test(i.label)),
      (items.find(i => i.bucket === "relations") || {}).label);

// A deletion whose car is gone is the deletion working, not a problem.
check("deletions are NOT reported -- a deletion whose car is gone got what it "
      + "wanted", !buckets.includes("deletions") && !buckets.includes("purged"),
      buckets.join(", "));

// Generation ids are minted by this layer and do not exist until the split they
// belong to is applied, so checking them would report every unapplied split.
check("a relation is judged on its nameplate ends, not on generation ids this "
      + "layer mints itself",
      !items.some(i => i.bucket === "relations" && i.id === "c|d|platform"));

check("each item says what KIND of decision it was, not just an id",
      items.every(i => i.what && i.what.length > 3),
      items.map(i => i.what).slice(0, 3).join(" / "));

// ---------- and it reaches the panel ----------
{
  const box = window.document.getElementById("llmdebug-orphans");
  const note = window.document.getElementById("llmdebug-orphans-note");
  const list = window.document.getElementById("llmdebug-orphans-list");
  window.document.getElementById("llmdebugbtn").onclick();
  check("the LLM Debug panel shows the count", box && box.hidden === false);
  check("...says how many and what it means", /point at a car that is not in the graph/.test(note.textContent),
        note.textContent.slice(0, 60));
  check("...says nothing is broken, because nothing is",
        /nothing is broken/.test(note.textContent));
  check("...and says how to deal with it", /[Rr]e-check/.test(note.textContent));
  check("...and lists them", list.children.length === items.length,
        list.children.length + " rows for " + items.length + " items");
}

// ---------- with a clean store it stays out of the way ----------
{
  const before = window.document.getElementById("llmdebug-orphans").hidden;
  // Emptied through the store directly: the panel's own delete paths resolve a
  // node first, and the whole point of these entries is that there is no node.
  const st = window.LLM_FAMILIES;
  [GONE, GONE2].forEach(id => {
    ["families", "recheck", "wpLinks", "genResearch", "merges", "renames", "unmerges"]
      .forEach(b => { if (st[b]) delete st[b][id]; });
  });
  delete st.relations["a|b|platform"];
  check("(sanity) it was showing before", before === false);
  const still = LF.orphanedEntries(cw.byId);
  check("with nothing orphaned, there is nothing to report", still.length === 0,
        still.map(i => i.bucket).join(", "));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
