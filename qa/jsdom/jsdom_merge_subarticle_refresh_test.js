// The remaining four reports from the same session.
//
// A. THE FREEZE. "The viewfinder gets completely blocked / goes blank during
//    live connection generation; only a refresh recovers." Root-caused by
//    measurement, not guesswork: indexMirrorReplacements ran an inner scan of
//    every link for every mirror link -- O(mirrors x links) -- and on the real
//    graph took over a second PER CALL, on a function called from a dozen
//    places including inside the live-update path. This locks the result: same
//    answers as the old nested scan, on the real graph, fast.
//
// B. THE MERGE. "The Honda Civic nameplate doesn't include the individual
//    generations... simply leave these generations alone when doing the merge
//    and don't override it with the general nameplate's wikipedia information,
//    as the information of the actual generation wikipedia page would be more
//    accurate."
//
// C. KIA PRIDE. "There are actually links within this wikipedia page which
//    describe the details about the specific car generations. I want that the
//    LLM also considers this, and tries to access these links."
//
// D. REFRESH SAFETY. "Make sure that if I do refresh the page that it doesn't
//    affect any of the calculations or matchings in the backend." Nothing is
//    ever written back into the build-time snapshot; every decision is a
//    record in llm_families.json replayed deterministically at boot. That is
//    the whole reason a refresh is safe -- so it needs a test that actually
//    boots twice over one store and compares the resulting graphs.
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

function freshWindow(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = opts.fetchImpl || (() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  window.LLM_FAMILIES = opts.llmSeed || { families: {}, relations: {}, recheck: {} };
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  load("platforms.js");
  return window;
}

// The real persisted store, so all four sections run against real decisions
// rather than a fixture shaped to agree with them.
const STORE_PATH = path.resolve(__dirname, "..", "..", "app", "llm_families.json");
const realStore = fs.existsSync(STORE_PATH)
  ? JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) : null;

// ============ A. the freeze ============
console.log("--- indexMirrorReplacements: same answers, no longer O(n^2) ---");
{
  const window = freshWindow({ llmSeed: realStore ? JSON.parse(JSON.stringify(realStore)) : undefined });
  const cw = window.CarWeb;
  cw.boot();
  const links = cw.links;
  const mirrors = links.filter(l => l.mirror);
  check("the real graph really does have mirror links to index", mirrors.length > 0, mirrors.length + " mirrors");

  // Snapshot what the fast path computed at boot.
  const fast = new Map(mirrors.map(l => [l.__idx === undefined ? links.indexOf(l) : l.__idx, l.mirrorAllRetired]));

  // Recompute with the ORIGINAL nested scan, verbatim in shape, as the oracle.
  const idOf = x => (typeof x === "string" ? x : (x && x.id));
  const famKey = n => (n && (n.familyOf || n.id)) || null;
  let disagree = 0;
  mirrors.forEach(l => {
    const famA = l.mirrorSourceFam || idOf(l.source), famB = l.mirrorTargetFam || idOf(l.target);
    const cands = links.filter(other => {
      if (other.mirror || !other.sn || !other.tn) return false;
      if (other.type !== l.type) return false;
      const a = famKey(other.sn), b = famKey(other.tn);
      return (a === famA && b === famB) || (a === famB && b === famA);
    });
    const slow = cands.length > 0 && cands.every(rl => rl.sn.retired || rl.tn.retired);
    const got = fast.get(l.__idx === undefined ? links.indexOf(l) : l.__idx);
    if (slow !== got) disagree++;
  });
  check("the rewritten index agrees with the old nested scan on EVERY real mirror",
    disagree === 0, disagree + " disagreements over " + mirrors.length + " mirrors");

  // And it's genuinely fast now. Not a microbenchmark for its own sake: the
  // reported symptom was a frozen canvas, and this function is called from
  // the live-update path, so a per-call budget is the actual requirement.
  // The threshold is deliberately loose (a slow CI box is fine); the bug was
  // 1000+ ms, so anything in this range proves the O(n^2) scan is gone.
  const expand = cw.nodes.filter(n => n.type === "family").slice(0, 5);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) { expand.forEach(f => { cw.expandFamily(f); cw.collapseFamily(f); }); }
  const per = (Date.now() - t0) / (20 * expand.length * 2);
  check("expand/collapse stays well under the freeze threshold", per < 120, per.toFixed(1) + " ms per op");
}

// ============ B. the Honda Civic merge ============
console.log("\n--- merging into a nameplate keeps its generations and their own articles ---");
{
  const window = freshWindow({});
  const cw = window.CarWeb, LF = window.LlmFamilies;
  cw.boot();

  // Build the reported shape by hand so it holds regardless of what the real
  // data currently looks like: a nameplate with generations that each carry
  // their OWN Wikipedia article, plus two loose duplicate models beside it.
  const nodes = cw.nodes, links = cw.links;
  nodes.push({ id: "mk-testhonda", type: "make", label: "TestHonda", year: 1948 });
  nodes.push({ id: "fam-th-civic", type: "family", label: "Civic", make: "TestHonda",
    wp: "Honda Civic", year: 1972, end: null, generations: ["g-th-civic-1", "g-th-civic-2"] });
  nodes.push({ id: "g-th-civic-1", type: "model", label: "Civic (1st gen)", make: "TestHonda",
    familyOf: "fam-th-civic", wp: "Honda Civic (first generation)", year: 1972, end: 1979 });
  nodes.push({ id: "g-th-civic-2", type: "model", label: "Civic (2nd gen)", make: "TestHonda",
    familyOf: "fam-th-civic", wp: "Honda Civic (second generation)", year: 1979, end: 1983 });
  nodes.push({ id: "m-th-civic-dup", type: "model", label: "Civic", make: "TestHonda",
    wp: "Honda Civic", year: 1972, end: null });
  nodes.push({ id: "m-th-civic-si", type: "model", label: "Civic Si", make: "TestHonda",
    wp: null, year: 1984, end: null });
  // The duplicate carries a connection that must survive the merge.
  nodes.push({ id: "p-th-designer", type: "person", label: "Test Designer", roles: ["designer"] });
  links.push({ source: "p-th-designer", target: "m-th-civic-dup", type: "designed" });
  // Re-index so the merge sees the nodes we just pushed.
  ["mk-testhonda", "fam-th-civic", "g-th-civic-1", "g-th-civic-2",
   "m-th-civic-dup", "m-th-civic-si", "p-th-designer"]
    .forEach(id => cw.byId.set(id, nodes.find(n => n.id === id)));

  const ok = LF.mergeModelsIntoNameplate("fam-th-civic",
    ["m-th-civic-dup", "m-th-civic-si"], nodes, links);
  check("the merge ran", !!ok);

  const fam = nodes.find(n => n.id === "fam-th-civic");
  const gens = (fam.generations || []).map(id => nodes.find(n => n.id === id)).filter(Boolean);
  const liveGens = gens.filter(g => !g.retired);
  // The exact bug: primary.generations was overwritten with only the NEW
  // members, silently dropping every generation the nameplate already had.
  check("the two PRE-EXISTING generations are still there (this is the reported bug)",
    fam.generations.includes("g-th-civic-1") && fam.generations.includes("g-th-civic-2"),
    JSON.stringify(fam.generations));
  check("the merged-in models joined them rather than replacing them",
    liveGens.length >= 3, liveGens.map(g => g.id).join(", "));

  // "Simply leave these generations alone... don't override it with the
  // general nameplate's wikipedia information."
  const g1 = nodes.find(n => n.id === "g-th-civic-1");
  const g2 = nodes.find(n => n.id === "g-th-civic-2");
  check("generation 1 kept its OWN article, not the nameplate's",
    g1.wp === "Honda Civic (first generation)", String(g1.wp));
  check("generation 2 kept its OWN article, not the nameplate's",
    g2.wp === "Honda Civic (second generation)", String(g2.wp));

  // The redundancy rule: a loose model identical to the nameplate is folded
  // away rather than left sitting beside it as a second "Honda Civic".
  const dup = nodes.find(n => n.id === "m-th-civic-dup");
  check("the redundant standalone duplicate is no longer a top-level model",
    dup.retired || dup.familyOf === "fam-th-civic", `retired=${dup.retired} familyOf=${dup.familyOf}`);
  // ...and it is hidden, never erased -- the connection it carried follows it.
  const credit = links.find(l => l.type === "designed" &&
    (l.target === "m-th-civic-dup" || (l.target && l.target.id === "m-th-civic-dup")));
  check("the connection the duplicate carried still exists (nothing is erased)", !!credit);

  // A merge is a record, so it is reversible.
  const merges = LF.allMerges();
  check("the merge was recorded so it can be replayed and undone",
    merges.some(m => m.primaryId === "fam-th-civic" || m.id === "fam-th-civic"),
    JSON.stringify(merges.map(m => m.primaryId || m.id)));
}

// ============ B2. ...and it asks rather than guesses when it can't tell ============
console.log("\n--- two articles both claiming to be the nameplate: ask, don't guess ---");
{
  // "If the LLM is unsure which to pick, then it should prompt the user and
  // have the user confirm which information to take."
  const window = freshWindow({});
  const cw = window.CarWeb, LF = window.LlmFamilies;
  cw.boot();
  const nodes = cw.nodes, links = cw.links;
  // A nameplate with NO article of its own, and two merge members that each
  // carry the nameplate's exact label with a DIFFERENT article -- the real
  // "Wikipedia has a disambiguated pair and neither is obviously right" shape.
  nodes.push({ id: "mk-testkia", type: "make", label: "TestKia", year: 1944 });
  nodes.push({ id: "m-tk-pride", type: "model", label: "Pride", make: "TestKia", wp: null, year: 1987, end: null });
  nodes.push({ id: "m-tk-pride-a", type: "model", label: "Pride", make: "TestKia", wp: "Kia Pride", year: 1987, end: 2000 });
  nodes.push({ id: "m-tk-pride-b", type: "model", label: "Pride", make: "TestKia", wp: "Kia Pride (Iran)", year: 2000, end: 2011 });
  ["mk-testkia", "m-tk-pride", "m-tk-pride-a", "m-tk-pride-b"]
    .forEach(id => cw.byId.set(id, nodes.find(n => n.id === id)));

  LF.mergeModelsIntoNameplate("m-tk-pride", ["m-tk-pride-a", "m-tk-pride-b"], nodes, links);
  const fam = nodes.find(n => n.id === "m-tk-pride");
  check("the nameplate was left with NO article rather than an arbitrary one",
    !fam.wp, String(fam.wp));

  const conflicts = LF.pendingMergeWpConflicts();
  const mine = conflicts.find(c => c.primaryId === "m-tk-pride");
  check("the ambiguity is recorded as a question for the user", !!mine,
    JSON.stringify(conflicts.map(c => c.primaryId)));
  check("both candidates are offered, not just the first",
    mine && mine.candidates.length === 2 &&
    mine.candidates.includes("Kia Pride") && mine.candidates.includes("Kia Pride (Iran)"),
    mine ? JSON.stringify(mine.candidates) : "-");

  // The generations still each keep their own article while the question sits
  // unanswered -- so an unanswered conflict costs nothing.
  const a = nodes.find(n => n.id === "m-tk-pride-a");
  check("an unanswered conflict is harmless: generations keep their own articles",
    a.wp === "Kia Pride", String(a.wp));

  // Answering it is a recorded decision, applied live.
  LF.resolveMergeWpChoice("m-tk-pride", "Kia Pride (Iran)", nodes).then(ok => {
    check("the user's answer was accepted", ok === true);
    check("...and applied to the nameplate immediately, no reload",
      fam.wp === "Kia Pride (Iran)", String(fam.wp));
    check("the question is no longer asked once answered",
      !LF.pendingMergeWpConflicts().some(c => c.primaryId === "m-tk-pride"));
    return LF.resolveMergeWpChoice("m-tk-pride", "Some Article Nobody Offered", nodes);
  }).then(bad => {
    check("an answer that wasn't one of the offered candidates is refused", bad === false);
  });
}

// ============ C. Kia Pride: follow the article's own generation links ============
console.log("\n--- {{Main|...}} sub-articles are fetched and become part of the evidence ---");
{
  const MAIN = [
    "{{Infobox automobile|name=Kia Pride|manufacturer=Kia}}",
    "The Kia Pride is a subcompact car.",
    "==First generation==",
    "{{Main|Kia Pride (first generation)}}",
    "A summary paragraph only.",
    "==Second generation==",
    "{{Main article|Kia Pride (second generation)}}",
    "Another summary paragraph.",
  ].join("\n");
  const SUBS = {
    "Kia Pride (first generation)":
      "The first-generation Kia Pride (Y) was produced from 1987 to 2000. Designed by Mario Maioli.",
    "Kia Pride (second generation)":
      "The second-generation Kia Pride (JB) ran from 2005 to 2011.",
  };
  const fetched = [];
  const window = freshWindow({
    fetchImpl: url => {
      const u = String(url);
      const m = /[?&]page=([^&]+)/.exec(u);
      const title = m ? decodeURIComponent(m[1]).replace(/_/g, " ") : null;
      if (title) fetched.push(title);
      const text = title === "Kia Pride" ? MAIN : (SUBS[title] || null);
      if (text === null) return Promise.resolve({ ok: true, json: async () => ({ error: { code: "missingtitle" } }) });
      return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": text } } }) });
    },
  });
  const LF = window.LlmFamilies;
  const node = { id: "m-kia-pride", type: "model", label: "Pride", make: "Kia", wp: "Kia Pride" };

  LF.buildNodePrompt(node).then(({ messages }) => {
    check("the nameplate's own article was fetched", fetched.includes("Kia Pride"));
    check("...and so were BOTH delegated generation articles (the reported gap)",
      fetched.includes("Kia Pride (first generation)") &&
      fetched.includes("Kia Pride (second generation)"), JSON.stringify(fetched));
    const prompt = messages.map(m => m.content).join("\n");
    check("the sub-article text reaches the model, labelled by its heading",
      /Kia Pride \(first generation\)/.test(prompt) && /First generation/i.test(prompt));

    // And the payoff: facts that exist ONLY in a sub-article now survive the
    // hallucination guard, instead of being validated away as "not in the
    // source" -- which is precisely why the Kia Pride came back empty.
    return LF.previewNodeResult(node, {
      hasMultipleGenerations: true,
      generations: [
        { code: "Y", yearStart: 1987, yearEnd: 2000, designers: ["Mario Maioli"], engineers: [], sharedPlatforms: [] },
        { code: "JB", yearStart: 2005, yearEnd: 2011, designers: [], engineers: [], sharedPlatforms: [] },
      ],
    });
  }).then(preview => {
    const codes = preview.clean.generations.map(g => g.code);
    check("both generations survive validation on sub-article evidence alone",
      codes.includes("Y") && codes.includes("JB"), JSON.stringify(codes));
    const y = preview.clean.generations.find(g => g.code === "Y");
    check("a designer named only in the sub-article is kept too",
      (y.designers || []).includes("Mario Maioli"), JSON.stringify(y.designers));
    runRefreshSection();
  }).catch(e => { check("Kia Pride section ran without throwing", false, e.message); runRefreshSection(); });
}

// ============ D. a refresh changes nothing ============
function runRefreshSection() {
  console.log("\n--- booting twice over the same store yields the identical graph ---");
  // The claim being tested is the architectural one: nothing is written back
  // into cars.json/data.js, so every boot rebuilds from the same snapshot plus
  // the same replayed records. If that ever stopped being true, a refresh
  // would quietly change the user's graph -- which is exactly the worry.
  function fingerprint(store) {
    const window = freshWindow({ llmSeed: JSON.parse(JSON.stringify(store)) });
    const cw = window.CarWeb;
    cw.boot();
    const live = cw.nodes.filter(n => !n.retired)
      .map(n => [n.id, n.type, n.label, n.make || "", n.familyOf || "", n.wp || "",
                 (n.generations || []).join(",")].join("")).sort();
    const idOf = x => (typeof x === "string" ? x : (x && x.id));
    const edges = cw.links.filter(l => !l.retired)
      .map(l => [idOf(l.source), idOf(l.target), l.type, l.mirror ? "m" : ""].join("")).sort();
    return { nodes: live, edges, counts: `${live.length}n/${edges.length}e` };
  }

  const store = realStore || { families: {}, relations: {}, recheck: {} };
  const a = fingerprint(store);
  const b = fingerprint(store);   // "the user pressed refresh"
  check("the same number of cars and connections after a refresh", a.counts === b.counts,
    `${a.counts} vs ${b.counts}`);
  const nodeDiff = a.nodes.findIndex((x, i) => x !== b.nodes[i]);
  check("every single node is identical after a refresh", nodeDiff === -1,
    nodeDiff === -1 ? "" : `first difference: ${a.nodes[nodeDiff]} vs ${b.nodes[nodeDiff]}`);
  const edgeDiff = a.edges.findIndex((x, i) => x !== b.edges[i]);
  check("every single connection is identical after a refresh", edgeDiff === -1,
    edgeDiff === -1 ? "" : `first difference: ${a.edges[edgeDiff]} vs ${b.edges[edgeDiff]}`);

  // A decision taken mid-session survives the refresh, rather than the
  // refresh being "safe" only because nothing was happening.
  const withDecision = JSON.parse(JSON.stringify(store));
  withDecision.deletions = Object.assign({}, withDecision.deletions, {
    "mk-fiat": { at: new Date().toISOString(), hard: true, reason: "test" },
  });
  const c = fingerprint(withDecision);
  const d = fingerprint(withDecision);
  check("a decision taken this session survives a refresh unchanged", c.counts === d.counts,
    `${c.counts} vs ${d.counts}`);
  check("...and it actually changed something (so the check above means something)",
    c.counts !== a.counts, `with deletion ${c.counts} vs without ${a.counts}`);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}
