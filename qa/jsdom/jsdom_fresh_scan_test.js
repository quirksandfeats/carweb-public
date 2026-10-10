// A requested scan is a full one (real user request, 2026-10-10): "when I do
// a request scan on the webapp, it should recheck all of the relationships as
// well, and go all the layers deep, etc... since it should be a full thorough
// complete check." The second Boxster and Cayman scan skipped the Ruf CTR3 and
// the Lykan behind it, because both had been checked once already.
//
// Seed S was checked before. Its platform partner P, P's successor Q and Q's
// related R: S, P and Q have answers on file, R does not; F is a nameplate
// joined to S. A requested scan must read every one of them again, within the
// depth budget, and keep what Andy rejected on a nameplate it merely reached.
// An ordinary click (LLM Check on a car already checked) still re-reads nothing.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = "2026-01-01T00:00:00.000Z";
const none = { status: "none", checkedAt: T, sourceTitle: "x", proposal: { hasMultipleGenerations: false, generations: [] }, attempts: 1, feedback: [] };

function boot(cascadeMaxDepth, hang, storeOverride) {
  const checked = [];
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  const saved = { last: null };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u === "/api/llm-families" && opts && opts.body) { try { saved.last = JSON.parse(opts.body); } catch (e) {} }
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      const m = decodeURIComponent(u).match(/page=([^&]+)/);
      const title = m ? m[1].replace(/\+/g, " ").replace(/_/g, " ") : "";
      const wt = title === "FreshT Fam"
        ? "The Fam.\n== Fam (F1) ==\nfirst.\n== Fam (F2) ==\nsecond."
        : "A car.";
      return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const sys = String(body.messages[0].content), user = String(body.messages[1].content);
      if (sys.includes("You extract car production-generation data")) {
        const mm = user.match(/^Car:\s*(.+)$/m);
        const car = mm ? mm[1].trim() : "";
        checked.push(car);
        if (hang && hang.test(car)) return new Promise(() => {});   // a check that never comes back
        const reply = /Fam/.test(car)
          ? { hasMultipleGenerations: true, generations: [
              { code: "F1", yearStart: 2000, yearEnd: 2005, designers: [], engineers: [], sharedPlatforms: [] },
              { code: "F2", yearStart: 2005, yearEnd: 2010, designers: [], engineers: [], sharedPlatforms: [] }] }
          : { hasMultipleGenerations: false, generations: [] };
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
  const D = window.CARDATA;
  const m = (id, label, y, e, extra) => Object.assign({ id, type: "model", label, make: "FreshT", wp: "FreshT " + label, year: y, end: e }, extra || {});
  D.nodes.push({ id: "mk-fresht", type: "make", label: "FreshT", year: 1950 },
    m("m-fresht-s", "Ess", 2000, 2010), m("m-fresht-p", "Pee", 2000, 2010), m("m-fresht-q", "Queue", 2010, 2020),
    m("m-fresht-r", "Arr", 2010, 2020),
    { id: "fam-fresht-fam", type: "family", label: "Fam", make: "FreshT", wp: "FreshT Fam", year: 2000, end: 2010,
      generations: ["m-fresht-fam-f1", "m-fresht-fam-f2"], designers: [], engineers: [] },
    m("m-fresht-fam-f1", "Fam (F1)", 2000, 2005, { familyOf: "fam-fresht-fam", wp: "FreshT Fam" }),
    m("m-fresht-fam-f2", "Fam (F2)", 2005, 2010, { familyOf: "fam-fresht-fam", wp: "FreshT Fam" }));
  ["s", "p", "q", "r", "fam-f1", "fam-f2"].forEach(x => D.links.push({ source: "m-fresht-" + x, target: "mk-fresht", type: "made" }));
  D.links.push({ source: "fam-fresht-fam", target: "mk-fresht", type: "made" },
    { source: "fam-fresht-fam", target: "m-fresht-fam-f1", type: "generation" },
    { source: "fam-fresht-fam", target: "m-fresht-fam-f2", type: "generation" },
    { source: "m-fresht-s", target: "m-fresht-p", type: "platform" },
    { source: "m-fresht-s", target: "fam-fresht-fam", type: "related" },
    { source: "m-fresht-p", target: "m-fresht-q", type: "succession" },
    { source: "m-fresht-q", target: "m-fresht-r", type: "related" });
  const rejectedKey = "fam-fresht-fam|m-something-else|platform";
  window.LLM_FAMILIES = Object.assign(storeOverride ? JSON.parse(JSON.stringify(storeOverride)) : {
    families: { "m-fresht-s": none, "m-fresht-p": none, "m-fresht-q": none },
    relations: {}, recheck: {}, rejectedRelations: { [rejectedKey]: true },
  }, { __serverAvailable: true, __config: { cascadeMaxDepth } });
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  return { window, cw, checked, LF: window.LlmFamilies, rejectedKey, saved };
}
const saw = (checked, name) => checked.some(c => c.includes(name));

(async () => {
  console.log("--- a requested scan, depth 3: everything it reaches is read again ---");
  {
    const { cw, checked, LF, rejectedKey, saved } = boot(3);
    const s = cw.byId.get("m-fresht-s");
    cw.openDetail(s);
    cw.requestScan(s);
    await sleep(3000);
    check("the seed is read again although it was checked before", saw(checked, "Ess"), JSON.stringify(checked));
    check("its platform partner, checked before, is read again", saw(checked, "Pee"), JSON.stringify(checked));
    check("the partner's successor, checked before, is read again (two hops)", saw(checked, "Queue"), JSON.stringify(checked));
    check("and the successor's never-checked related car (three hops)", saw(checked, "Arr"), JSON.stringify(checked));
    check("a nameplate it is joined to is re-checked as a nameplate", saw(checked, "Fam"), JSON.stringify(checked));
    check("each car is read once per scan, not once per path to it",
      checked.filter(c => c.includes("Pee")).length === 1 && checked.filter(c => c.includes("Fam")).length === 1, JSON.stringify(checked));
    check("what Andy rejected on a nameplate the scan only reached stays rejected",
      !!(saved.last && saved.last.rejectedRelations && saved.last.rejectedRelations[rejectedKey]),
      saved.last ? Object.keys(saved.last.rejectedRelations || {}).join(",") : "nothing saved");
    check("the fresh answer replaced the old one", LF.entryFor("m-fresht-p").checkedAt !== T, LF.entryFor("m-fresht-p").checkedAt);
  }
  console.log("\n--- the same scan at depth 2 stops two hops out ---");
  {
    const { cw, checked } = boot(2);
    const s = cw.byId.get("m-fresht-s");
    cw.openDetail(s);
    cw.requestScan(s);
    await sleep(3000);
    check("two hops are read", saw(checked, "Pee") && saw(checked, "Queue"), JSON.stringify(checked));
    check("the third hop is not", !saw(checked, "Arr"), JSON.stringify(checked));
  }
  console.log("\n--- an ordinary LLM Check on a car already checked re-reads nothing ---");
  {
    const { cw, checked } = boot(3);
    cw.setLlmCheck(true);
    cw.openDetail(cw.byId.get("m-fresht-s"));
    await sleep(2000);
    check("no partner checked before is read again", !saw(checked, "Pee") && !saw(checked, "Queue"), JSON.stringify(checked));
  }
  console.log("\n--- one car that never answers does not hold up the rest ---");
  {
    const { cw, checked, LF } = boot(3, /Pee/);
    LF.setCarTimeout(400);
    const s = cw.byId.get("m-fresht-s");
    cw.openDetail(s);
    cw.requestScan(s);
    await sleep(3000);
    check("the stuck car was asked", saw(checked, "Pee"), JSON.stringify(checked));
    check("the car queued behind it is still checked", saw(checked, "Fam"), JSON.stringify(checked));
    const pw = LF.pendingWork();
    check("the stuck car is reported as given up on", (pw.abandoned || []).some(x => /Pee/.test(x)), JSON.stringify(pw.abandoned));
    check("...and is not counted as outstanding work, so the run can finish",
      !pw.checks.includes("m-fresht-p") && pw.total === 0, JSON.stringify(pw));
  }

  // ---------- the page crashes mid-scan, and a new page picks it up ----------
  console.log("\n--- a full scan survives the page crashing: the saved list carries it on ---");
  {
    // The first page gets stuck on Queue (it never answers), which is where
    // it "crashes": everything it saved is what a new page has to go on.
    const first = boot(3, /Queue/);
    first.LF.setCarTimeout(60000);
    const s1 = first.cw.byId.get("m-fresht-s");
    first.cw.openDetail(s1);
    first.cw.requestScan(s1);
    await sleep(3000);
    const saved = JSON.parse(JSON.stringify(first.saved.last));
    check("the scan in progress is on disk, with what it has already read",
      saved.fullScan && saved.fullScan.done["m-fresht-s"] && saved.fullScan.done["m-fresht-p"], JSON.stringify(saved.fullScan));
    check("...and the car it was on is on the saved list, marked as part of the scan",
      saved.pendingCascade["m-fresht-q"] && saved.pendingCascade["m-fresht-q"].fresh, JSON.stringify(saved.pendingCascade));

    const second = boot(3, null, saved);
    const n = second.LF.resumeCascade(second.cw.nodes, { cascade: true });
    await sleep(3000);
    check("a new page picks the scan back up", n >= 1, n);
    check("...reads the car it was stuck on", saw(second.checked, "Queue"), JSON.stringify(second.checked));
    check("...and keeps branching out from it", saw(second.checked, "Arr"), JSON.stringify(second.checked));
    check("...without reading again what the first page already had",
      !saw(second.checked, "Ess") && !saw(second.checked, "Pee") && !saw(second.checked, "Fam"), JSON.stringify(second.checked));
    check("the finished scan is closed off", second.LF.finishFullScan() === 0 &&
      second.saved.last && second.saved.last.fullScan === null, JSON.stringify(second.saved.last && second.saved.last.fullScan));

    const third = boot(3, null, saved);
    third.LF.resumeCascade(third.cw.nodes, { cascade: true, skip: ["m-fresht-q"] });
    await sleep(2000);
    check("a car set aside after crashing the page is not run again now", !saw(third.checked, "Queue"), JSON.stringify(third.checked));
    check("...but stays on the list for a later --resume, marked as set aside",
      third.saved.last && third.saved.last.pendingCascade["m-fresht-q"] && third.saved.last.pendingCascade["m-fresht-q"].deferred,
      JSON.stringify(third.saved.last && third.saved.last.pendingCascade));
    check("...and while it is there the scan is not closed off", third.LF.finishFullScan() > 0);

    const withJob = Object.assign({}, saved, { jobs: [{ id: "j1", kind: "node-check", targetId: "m-fresht-s", label: "FreshT Ess", state: "running" }] });
    const fourth = boot(3, null, withJob);
    const deferred = fourth.LF.deferJobs(["m-fresht-s"]);
    await sleep(300);
    check("a requested car that keeps crashing the page leaves the queue for the saved list",
      deferred === 1 && fourth.LF.jobs().length === 0 &&
      fourth.saved.last.pendingCascade["m-fresht-s"] && fourth.saved.last.pendingCascade["m-fresht-s"].deferred,
      JSON.stringify(fourth.LF.jobs()));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
