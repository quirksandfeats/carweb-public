// What a scan leaves "waiting for review" that the rules can answer used to wait
// for the next page load, and the agent loads a page once per request, before
// the scan. The Mitsubishi Colt's list and 123 flags waited on 2 Nov 2026.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ARTICLES = {
  "TestSt Colt": "{{Infobox automobile|name=TestSt Colt}}\n==First (A1; 1990)==\nBuilt 1990 to 1999. Related to the TestSt Named.\n==Second (A2; 2000)==\nBuilt 2000 to 2009.\n==Third (A3; 2010)==\nBuilt 2010 to 2019.\n",
  "TestSt Named": "{{Infobox automobile|name=TestSt Named}}\nA car.\n",
  "TestSt Stray": "{{Infobox automobile|name=TestSt Stray}}\nA car.\n",
};
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window: w } = dom;
w.HTMLCanvasElement.prototype.getContext = fakeCtx;
w.requestAnimationFrame = () => 1;
w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
w.Element.prototype.scrollIntoView = () => {};
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
w.fetch = async url => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m && String(url).includes("prop=wikitext")) {
    const title = decodeURIComponent(m[1]);
    return { ok: true, json: async () => ARTICLES[title] ? { parse: { title, wikitext: { "*": ARTICLES[title] } } } : { error: {} } };
  }
  if (String(url) === "/api/llm/chat") {
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hasMultipleGenerations: true, generations: [
      { code: "A1", yearStart: 1990, yearEnd: 1999, designers: [], engineers: [], sharedPlatforms: [] },
      { code: "A2", yearStart: 2000, yearEnd: 2009, designers: [], engineers: [], sharedPlatforms: [] }] }) } }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const FAM = "fam-testst-colt", A1 = "m-testst-a1", A2 = "m-testst-a2", A3 = "m-testst-a3";
const car = (id, label, year, end, wp, more) => Object.assign({ id, type: "model", label, make: "TestSt", year, end, wp }, more);
w.CARDATA.nodes.push({ id: "mk-testst", type: "make", label: "TestSt" },
  { id: FAM, type: "family", label: "Colt", make: "TestSt", wp: "TestSt Colt", generations: [A1, A2, A3] },
  car(A1, "Colt (A1)", 1990, 1999, "TestSt Colt", { familyOf: FAM }),
  car(A2, "Colt (A2)", 2000, 2009, "TestSt Colt", { familyOf: FAM }),
  car(A3, "Colt (A3)", 2010, 2019, "TestSt Colt", { familyOf: FAM }),
  car("m-testst-named", "Named", 1990, 1999, "TestSt Named"),
  car("m-testst-stray", "Stray", 1990, 1999, "TestSt Stray"),
  car("m-testst-old", "Old", 1975, 1979, "TestSt Named"));
w.CARDATA.links.push({ source: FAM, target: A1, type: "generation" }, { source: FAM, target: A2, type: "generation" }, { source: FAM, target: A3, type: "generation" });
const FLAG_KEPT = `${A1}|m-testst-named|platform`, FLAG_GONE = `${A1}|m-testst-stray|platform`;
const GUESS = "fam-testst-colt|m-testst-old|platform", BACKED = `${A1}|m-testst-old|platform`, OVER_NO = "fam-testst-colt|m-testst-stray|related";
const flag = { kind: "remove", checkedAt: "x", reason: "the current article text no longer mentions it" };
const rel = (a, b, gen, more) => Object.assign({ famA: a, famB: b, genIdA: gen, genIdB: b, relType: "platform", status: "confirmed" }, more);
w.LLM_FAMILIES = {
  families: {}, rejectedRelations: { [OVER_NO]: true },
  recheck: { [FAM]: { status: "provisional", sourceTitle: "TestSt Colt", discrepancy: "2 against 3",
    sections: [[1, "First (A1; 1990)"], [1, "Second (A2; 2000)"], [1, "Third (A3; 2010)"]],
    proposal: { hasMultipleGenerations: true, generations: [
      { code: "A1", yearStart: 1990, yearEnd: 1999, designers: [], engineers: [], sharedPlatforms: [] },
      { code: "A2", yearStart: 2000, yearEnd: 2009, designers: [], engineers: [], sharedPlatforms: [] }] } } },
  relations: {
    [FLAG_KEPT]: rel(FAM, "m-testst-named", A1, { reworkPending: flag }),
    [FLAG_GONE]: rel(FAM, "m-testst-stray", A1, { reworkPending: flag }),
    [BACKED]: rel(FAM, "m-testst-old", A1),
    [GUESS]: rel(FAM, "m-testst-old", A3, { status: "provisional", matchLevel: "generation", codeA: "Colt (A3)", codeB: "Old" }),
    [OVER_NO]: rel(FAM, "m-testst-stray", A1, { status: "provisional", relType: "related", matchLevel: "generation" }),
  },
  __serverAvailable: true,
};
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies, S = w.LLM_FAMILIES;
const waitFor = async (c, ms) => { for (let i = 0; i < ms / 50; i++) { if (c()) return true; await sleep(50); } return false; };
(async () => {
  // The load's own pass: then nothing is left for the scan's, so raise it all again.
  await sleep(4500);
  await waitFor(() => !LF.pendingWork().settling, 8000);
  Object.assign(S.relations, {
    [FLAG_KEPT]: rel(FAM, "m-testst-named", A1, { reworkPending: flag }),
    [FLAG_GONE]: rel(FAM, "m-testst-stray", A1, { reworkPending: flag }),
    [GUESS]: rel(FAM, "m-testst-old", A3, { status: "provisional", matchLevel: "generation", codeA: "Colt (A3)", codeB: "Old" }),
    [OVER_NO]: rel(FAM, "m-testst-stray", A1, { status: "provisional", relType: "related", matchLevel: "generation" }),
  });
  delete S.rejectedRelations[FLAG_GONE];
  S.recheck[FAM].status = "provisional";
  LF.registerJobRunner("test-scan", async () => {});
  LF.enqueueJob({ kind: "test-scan", targetId: FAM, label: "Colt" });
  const seen = await waitFor(() => LF.pendingWork().settling, 2000);
  t("the end of a request starts the settling", seen);
  t("the agent waits while it runs: it counts as outstanding work", !seen || LF.pendingWork().total > 0, JSON.stringify(LF.pendingWork()));
  await waitFor(() => !LF.pendingWork().settling, 8000);
  t("a list the rules change nothing in is closed", S.recheck[FAM].status === "none", S.recheck[FAM].status);
  t("a flag whose article names the other car is cleared", S.relations[FLAG_KEPT] && !S.relations[FLAG_KEPT].reworkPending);
  t("a flag neither article backs goes, as a no", !S.relations[FLAG_GONE] && S.rejectedRelations[FLAG_GONE]);
  t("a generation guess with no shared years on a connected pair is answered none",
    S.relations[GUESS] && S.relations[GUESS].status === "none" && !S.relations[GUESS].genIdA, JSON.stringify(S.relations[GUESS]).slice(0, 120));
  t("...not declined, so the nameplate-level link stays", !S.rejectedRelations[GUESS]);
  t("a proposal written over a no on file stays a no", !S.relations[OVER_NO]);
  t("nothing outstanding afterwards", !LF.pendingWork().total, JSON.stringify(LF.pendingWork()));
  // Nothing open: no pass, so a test or a run with nothing to do never waits on it.
  await LF.settleAfterScans();
  t("with nothing open it does not run", !LF.pendingWork().settling);
  // Same years as a generation: a guess that could be right still waits.
  S.relations[GUESS] = rel(FAM, "m-testst-old", A1, { status: "provisional", matchLevel: "generation", famB: "m-testst-named", genIdB: "m-testst-named" });
  await LF.settleAfterScans();
  t("a guess whose years meet still waits for a person", S.relations[GUESS].status === "provisional", S.relations[GUESS].status);
  // Asked for by name: the Colt's own shape, a re-read that leaves out a
  // generation the article still has a section for.
  const byId = id => w.CarWeb.nodes.find(n => n.id === id);
  const res = await LF.forceRecheckFamily(byId(FAM), [byId(A1), byId(A2), byId(A3)], w.CarWeb.nodes, w.CarWeb.links);
  t("a list asked for by name with nothing to change does not wait", res.status === "none", res.status + " " + (res.error || ""));
  t("...and says why", /stay|same/.test(res.settledWhy || ""), res.settledWhy);
  console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})();
