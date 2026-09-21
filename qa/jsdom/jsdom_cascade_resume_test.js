// The overnight run that crashed.
//
//   [18:19:40]   still working on Peugeot 407, Buick Velite 7, Chevrolet Bolt
//                EUV, Opel Cascada (+134 more)
//   [18:19:42] FAILED: Page.wait_for_timeout: Page crashed
//
// Two things, both tested here:
//
// 1. The 130-odd cars queued behind the one running were lost -- the queue
//    lived only in the page. It is written down now (store.pendingCascade) as
//    each car joins it, crossed off as each check lands, and picked back up
//    by resumeCascade. A page load must never start it by itself.
//
// 2. The likely cause: every write serialised the whole 6.6 MB store into a
//    request body of its own, with nothing stopping dozens being alive at
//    once. persist() now keeps one write in flight and one waiting.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
};
function fakeCtx() {
  const noop = () => {};
  return new Proxy({ measureText: () => ({ width: 10 }) },
                   { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

const MK = "mk-resume", CAR = "m-resume-car", GONE = "m-resume-gone", GEN = "m-resume-gen";
const FAM = "fam-resume", DONE = "m-resume-done";
let posts = 0, lastBody = null, inFlight = 0, maxInFlight = 0, llmCalls = 0;
let releasePost = null;
const holdPosts = { on: false };

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });
window.fetch = (u, o) => {
  const s = String(u);
  if (s === "/api/llm-families" && o && o.method === "POST") {
    posts++; lastBody = o.body; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const done = () => { inFlight--; return { ok: true, json: async () => ({ ok: true }) }; };
    if (holdPosts.on) return new Promise(r => { releasePost = () => r(done()); });
    return new Promise(r => setTimeout(() => r(done()), 5));
  }
  if (s === "/api/llm/chat") {
    llmCalls++;
    return Promise.resolve({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ hasMultipleGenerations: false,
        generations: [{ code: "Resume Car", yearStart: 2001, yearEnd: null, designers: [],
                        engineers: [], sharedPlatforms: [] }] }) }, finish_reason: "stop" }],
    }) });
  }
  if (/[?&]page=/.test(s)) {
    return Promise.resolve({ ok: true, json: async () => ({
      parse: { title: "Resume Car", wikitext: { "*": "{{Infobox automobile|name=Resume Car|production=2001-present}}\nResume Car text." } },
    }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;

const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    D.nodes.push({ id: MK, type: "make", label: "Resume", year: 1900 });
    D.nodes.push({ id: CAR, type: "model", label: "Car", make: "Resume", wp: "Resume Car",
                   year: 2001, designers: [], engineers: [] });
    D.nodes.push({ id: DONE, type: "model", label: "Done", make: "Resume", wp: "Resume Done",
                   year: 2002, designers: [], engineers: [] });
    D.nodes.push({ id: FAM, type: "family", label: "Fam", make: "Resume", year: 1990,
                   generations: [GEN], designers: [], engineers: [] });
    D.nodes.push({ id: GEN, type: "model", label: "Fam Gen", make: "Resume", familyOf: FAM,
                   year: 1990, designers: [], engineers: [] });
    D.links.push({ source: MK, target: CAR, type: "made" }, { source: MK, target: DONE, type: "made" },
                 { source: MK, target: FAM, type: "made" }, { source: FAM, target: GEN, type: "generation" });
    window.LLM_FAMILIES = {
      families: { [DONE]: { status: "none", checkedAt: "x" } },
      relations: {}, recheck: {},
      pendingCascade: {
        [CAR]:  { depth: 2, from: "m-somewhere", at: "x" },
        [GONE]: { depth: 1, from: null, at: "x" },         // not in the graph any more
        [GEN]:  { depth: 1, from: null, at: "x" },         // a generation: never checked alone
        [DONE]: { depth: 1, from: null, at: "x" },         // checked since
      },
      // The depth a user runs at. A car saved at depth 2 is resumed at 2
      // under this; under a lower limit it would be capped to that.
      __config: { cascadeMaxDepth: 7 },
      __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;

(async () => {
  await new Promise(r => setTimeout(r, 30));

  // ---------- a page load never starts it ----------
  check("booting with a saved cascade makes no model call", llmCalls === 0, llmCalls);
  // Reported, but not counted as work in progress: nothing is running it
  // yet, and counting it would make the agent sit out its idle timeout at the
  // end of every pass that leaves one behind.
  check("...but reports what is saved", LF.pendingWork().saved === 4, JSON.stringify(LF.pendingWork()));
  check("...without counting it as work in progress until it is picked up",
        LF.pendingWork().total === 0, LF.pendingWork().total);

  // ---------- picking it up ----------
  LF.setBackgroundAllowed(true);
  const queued = LF.resumeCascade(cw.nodes);
  check("only the car that still needs checking is queued", queued === 1, queued);
  check("...the gone, the generation and the already-checked are crossed off",
        LF.pendingCascadeCount() === 1, LF.pendingCascadeCount());
  check("...and it is queued at the depth it had, not restarted from zero",
        LF.cascadeDepthOf(CAR) === 2, LF.cascadeDepthOf(CAR));

  for (let i = 0; i < 40 && !LF.entryFor(CAR); i++) await new Promise(r => setTimeout(r, 25));
  check("the resumed car is actually checked", !!LF.entryFor(CAR),
        JSON.stringify(LF.entryFor(CAR)));
  await new Promise(r => setTimeout(r, 30));
  check("...and crossed off the saved list once it has an answer",
        LF.pendingCascadeCount() === 0, LF.pendingCascadeCount());
  check("resuming again finds nothing to do", LF.resumeCascade(cw.nodes) === 0);

  // ---------- writes: one in flight, one waiting ----------
  await new Promise(r => setTimeout(r, 50));
  posts = 0; maxInFlight = 0;
  holdPosts.on = true;
  const ps = [];
  for (let i = 0; i < 50; i++) ps.push(LF.persistForTests ? LF.persistForTests() : null);
  check("the persist hook is exposed to the suite", !!LF.persistForTests);
  await new Promise(r => setTimeout(r, 10));
  check("fifty writes in a burst put ONE body on the wire, not fifty",
        posts === 1 && maxInFlight === 1, `${posts} posted, ${maxInFlight} at once`);
  holdPosts.on = false;
  releasePost();
  await Promise.all(ps);
  check("...and one more carrying everything since, once that one landed",
        posts === 2, posts);
  check("every caller's promise resolves", ps.every(p => p && typeof p.then === "function"));
  check("the saved list travels with the store",
        JSON.parse(lastBody).pendingCascade !== undefined);

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
