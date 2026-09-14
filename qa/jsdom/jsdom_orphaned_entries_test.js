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
//
// The second half of this file is the follow-up report: "I figured that if i
// re-scanned the mercedes GLA nameplate, that the entry would disappear from
// the list. I guess I am still confused about what these cars actually
// represent." It never would have. Those entries were filed under an
// llm-related- PLACEHOLDER -- a stand-in minted when an article named a car
// the graph did not have -- and once the real car exists, nothing re-checks
// the placeholder and nothing reaches it. Two different situations wearing one
// explanation, so: the placeholder kind is classified apart and cleared
// automatically at boot, the renamed kind is kept and now says what it
// actually is, and there is one button to throw the rest away instead of the
// per-row delete the old copy promised and never had.
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
// The stand-ins: decisions filed under a placeholder that was minted for a car
// the graph did not have at the time. Exactly the shape of the real report --
// a split, a pasted Wikipedia link, and a connection whose missing end is the
// placeholder. Seeded BEFORE boot, because boot is what clears them.
const STANDIN = "llm-related-testorph-standin";
const STANDIN2 = "llm-related-testorph-gla-class-x156";
const STANDIN_MAKE = "llm-make-testorphan";
window.LLM_FAMILIES.families[STANDIN] = { status: "confirmed", proposal: { generations: [] } };
window.LLM_FAMILIES.wpLinks[STANDIN2] = "TestOrph GLA-Class (X156)";
window.LLM_FAMILIES.renames[STANDIN_MAKE] = { label: "TestOrphan", previousLabel: "TestOrph", kind: "make" };
window.LLM_FAMILIES.relations["e|f|platform"] =
  { status: "confirmed", famA: STANDIN, famB: STANDIN2, relType: "platform" };
// One end a placeholder, the other a real car that was renamed away: worth
// keeping, because half of it is still actionable.
window.LLM_FAMILIES.relations["g|h|platform"] =
  { status: "confirmed", famA: STANDIN, famB: GONE, relType: "platform" };
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
  check("...says how many and what it means", /decisions point at a car whose id has moved/.test(note.textContent),
        note.textContent.slice(0, 70));
  check("...explains WHY a rename detaches the work, since that is the whole "
        + "mechanism", /id is built from a car's make and label/.test(note.textContent));
  check("...and covers the other way an id moves: a nameplate this layer minted "
        + "itself, whose split changed", /split behind it changes/.test(note.textContent));
  check("...says nothing is broken, because nothing is",
        /nothing is broken/.test(note.textContent));
  check("...and says how to deal with it", /[Rr]e-check/.test(note.textContent));
  check("...and no longer claims the placeholder story, which is what sent the "
        + "user re-scanning a car this list was never about",
        !/different name or maker/.test(note.textContent));
  check("...and lists them", list.children.length === items.length,
        list.children.length + " rows for " + items.length + " items");
}

// ---------- the two kinds, and the automatic half ----------
{
  check("a placeholder id is classified as a stand-in", LF.orphanKind(STANDIN) === "stand-in",
        LF.orphanKind(STANDIN));
  check("...an invented marque too", LF.orphanKind(STANDIN_MAKE) === "stand-in",
        LF.orphanKind(STANDIN_MAKE));
  check("a real car's id is classified as renamed", LF.orphanKind(GONE) === "renamed",
        LF.orphanKind(GONE));

  const st = window.LLM_FAMILIES;
  check("boot cleared the split filed under a placeholder", !(STANDIN in st.families));
  check("...the pasted link too", !(STANDIN2 in st.wpLinks));
  check("...and the invented marque's rename", !(STANDIN_MAKE in st.renames));
  check("...and a connection whose every missing end was a placeholder",
        !("e|f|platform" in st.relations));
  check("but NOT a connection that still has a real renamed car in it",
        "g|h|platform" in st.relations);
  check("and not one single decision about a real car",
        (GONE in st.families) && (GONE2 in st.wpLinks) && (GONE in st.merges),
        Object.keys(st.families).join(","));

  const pruned = LF.prunedDecisions();
  check("what was cleared is recorded, so nothing vanishes without a trace",
        ("families|" + STANDIN) in pruned && ("wpLinks|" + STANDIN2) in pruned,
        Object.keys(pruned).join(", "));
  // The archive is only useful if it is still there next time. `store` is a
  // literal of known keys and persist() POSTs all of it, so a key created only
  // when there is something to clear lives for one session and the next boot's
  // first persist wipes it. Found in the real file after the first boot in the
  // wild cleared 78 entries and recorded none of them.
  check("the archive is read back out of the store at boot, so it survives a "
        + "reload rather than being wiped by the next save",
        /prunedDecisions:\s*bootData\.prunedDecisions/.test(
          require("fs").readFileSync(require("path").join(APP, "llm_families.js"), "utf-8")));
  check("...keyed by bucket as well as id, since one id can hold two "
        + "different decisions",
        Object.keys(pruned).length > 0 && Object.keys(pruned).every(k => k.includes("|")),
        Object.keys(pruned).length + " archived");

  check("nothing of the stand-in kind is left to report",
        LF.orphanedEntries(cw.byId).every(i => i.kind !== "stand-in"));
  check("running the prune again finds nothing -- it is not re-deleting or "
        + "re-recording on every boot",
        LF.pruneStandInOrphans(cw.byId).cleared === 0);
}

// ---------- the one button that clears the rest ----------
// The old copy told the user to delete the entry "below". There was no delete
// control of any kind, and 80 rows would have been absurd one at a time.
{
  const box = window.document.getElementById("llmdebug-orphans");
  const btn = window.document.getElementById("orphans-clear");
  const yes = window.document.getElementById("orphans-clear-confirm");
  const no = window.document.getElementById("orphans-clear-cancel");
  const say = window.document.getElementById("orphans-clear-status");
  const n = LF.orphanedEntries(cw.byId).length;

  check("(sanity) it was showing before", box.hidden === false);
  check("there is a delete control at all, and it says how many", !!btn && btn.textContent.includes(String(n)),
        btn && btn.textContent);
  check("...and it is not armed until it is clicked", yes.hidden === true);

  btn.onclick();
  check("clicking it asks first, rather than deleting completed work on one click",
        yes.hidden === false && no.hidden === false);
  check("...and warns that hand-typed decisions are the part that cannot be redone",
        /typed yourself/.test(say.textContent), say.textContent.slice(0, 80));

  no.onclick();
  check("cancelling deletes nothing", LF.orphanedEntries(cw.byId).length === n &&
        yes.hidden === true, LF.orphanedEntries(cw.byId).length + " vs " + n);

  btn.onclick(); yes.onclick();
  const left = LF.orphanedEntries(cw.byId);
  check("confirming clears the whole list", left.length === 0,
        left.map(i => i.bucket + ":" + i.id).join(", "));
  check("...and the section takes itself away", box.hidden === true);
  check("...and says what it did", /deleted \d+ decision/.test(say.textContent),
        say.textContent);

  const st = window.LLM_FAMILIES;
  check("the cleared decisions are archived like the automatic ones",
        Object.keys(LF.prunedDecisions()).some(k => k === "families|" + GONE),
        Object.keys(LF.prunedDecisions()).length + " archived");
  check("and a decision about a car that IS here was never touched",
        "m-test-orph-present" in st.families && "m-test-orph-present" in st.wpLinks);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
