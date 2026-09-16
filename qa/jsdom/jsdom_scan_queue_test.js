// Real user request: "If I want to add further cars for the LLM to check (in
// serve.py, or in the web version, or anywhere), make sure that the request is
// properly added to the queue in a way that it does not ruin any scanning or
// have data loss. I want there to also be a queuing system everywhere,
// including serve.py, for if I want to request several different models to be
// checked and I want to request to scan them while others are already
// currently being scanned."
//
// What was wrong. Every button started its pass the moment it was pressed. Two
// at once is not merely slow: both read the whole store and both POST the whole
// store back, so the second POST -- built from a snapshot taken before the
// first one's writes -- erases them. And pressing a button while something ran
// looked exactly like pressing a button that does nothing.
//
// So: one user-requested pass at a time, in the order they were asked for, with
// what is waiting written to disk so a reload keeps it. Measured here by when
// each runner actually starts, not by what the queue says about itself.
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

const A = "m-testq-alpha", B = "m-testq-beta", C = "m-testq-gamma";

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

// Every POST of the store is kept, so "was the queue actually written to disk"
// is answered by what serve.py would have received.
const persisted = [];
window.fetch = (url, opts) => {
  const u = String(url);
  if (u === "/api/llm-families" && opts && opts.method === "POST") {
    persisted.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  if (/[?&]page=/.test(u)) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-testq", type: "make", label: "TestQ", year: 1990 };
    D.nodes.push(mk);
    D.links.push({ source: mk.id, target: mk.id, type: "made" });
    [[A, "Alpha"], [B, "Beta"], [C, "Gamma"]].forEach(([id, label]) => {
      D.nodes.push({ id, type: "model", label, make: "TestQ", year: 1990,
                     wp: "TestQ " + label, designers: [], engineers: [] });
      D.links.push({ source: id, target: mk.id, type: "made" });
    });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;

// The real runners are replaced with ones that say when they started and when
// they finished, and hold until released. Overlap is then a fact about the log
// rather than a guess.
const log = [];
const holds = new Map();
function stubRunner(kind) {
  LF.registerJobRunner(kind, job => {
    log.push("start:" + job.targetId);
    return new Promise(res => holds.set(job.targetId, () => { log.push("end:" + job.targetId); res(); }));
  });
}
["node-check", "family-recheck", "engine-read"].forEach(stubRunner);
const release = id => { const f = holds.get(id); if (f) { holds.delete(id); f(); } };
const ids = () => LF.jobs().map(j => j.targetId + ":" + j.state).join(" ");

(async () => {
  // ---------- 1. one at a time, in order ----------
  LF.enqueueJob({ kind: "node-check", targetId: A, label: "TestQ Alpha" });
  await sleep(10);
  check("the first request starts straight away", log.join(" ") === "start:" + A, log.join(" "));

  LF.enqueueJob({ kind: "node-check", targetId: B, label: "TestQ Beta" });
  LF.enqueueJob({ kind: "node-check", targetId: C, label: "TestQ Gamma" });
  await sleep(10);
  check("asking for two more while it runs starts neither of them",
        log.join(" ") === "start:" + A, log.join(" "));
  check("...they are in the queue, waiting, in the order they were asked for",
        ids() === `${A}:running ${B}:waiting ${C}:waiting`, ids());
  check("...and the panel can say where a given car stands",
        LF.jobPositionFor(A) === 0 && LF.jobPositionFor(B) === 1 && LF.jobPositionFor(C) === 2,
        [LF.jobPositionFor(A), LF.jobPositionFor(B), LF.jobPositionFor(C)].join(","));

  release(A);
  await sleep(10);
  check("finishing the first starts the second, and only the second",
        log.join(" ") === `start:${A} end:${A} start:${B}`, log.join(" "));
  check("...and the one that finished is out of the queue",
        ids() === `${B}:running ${C}:waiting`, ids());

  // ---------- 2. the same request twice is one request ----------
  const dup = LF.enqueueJob({ kind: "node-check", targetId: C, label: "TestQ Gamma" });
  check("asking for the same car again does not queue it twice",
        !!(dup && dup.duplicate) && LF.jobs().length === 2, ids());
  // Different WORK on the same car is a different request, though.
  const other = LF.enqueueJob({ kind: "engine-read", targetId: C, label: "TestQ Gamma" });
  check("...but different work on the same car is its own request",
        !!other && !other.duplicate && LF.jobs().length === 3, ids());

  // ---------- 3. withdrawing one ----------
  const engJob = LF.jobFor(C, "engine-read");
  check("a waiting request can be withdrawn", LF.cancelJob(engJob.id).ok === true);
  const runJob = LF.runningJob();
  check("...but not the one being worked on -- a cut-off check is lost",
        LF.cancelJob(runJob.id).error === "running", JSON.stringify(LF.cancelJob(runJob.id)));

  // ---------- 4. it is on disk, not just in memory ----------
  const last = persisted[persisted.length - 1];
  check("the queue is written to llm_families.json",
        Array.isArray(last.jobs) && last.jobs.some(j => j.targetId === C), JSON.stringify((last.jobs || []).map(j => j.targetId)));
  const withRunning = persisted.filter(p => (p.jobs || []).some(j => j.state === "running"));
  check("...including which one was mid-pass when it was written",
        withRunning.length > 0, withRunning.length);

  // ---------- 5. outstanding work is reported as outstanding ----------
  // This is what the agent's settle test reads. Without it a run would declare
  // itself finished and exit with requested cars still queued.
  const p = LF.pendingWork();
  check("queued requests count as work still outstanding", p.total >= 2, JSON.stringify(p));
  check("...naming the one running and the ones waiting separately",
        p.running.concat(p.queued).sort().join(",") === [B, C].sort().join(","),
        JSON.stringify({ running: p.running, queued: p.queued }));

  release(B);
  await sleep(10);
  release(C);
  await sleep(10);
  check("the queue empties", LF.jobs().length === 0 && !LF.runningJob(), ids());
  check("...and the last one to finish is remembered, so the panel can say so",
        (LF.lastJob() || {}).targetId === C, JSON.stringify(LF.lastJob()));

  // ---------- 6. a kind this build does not know does not block the rest ----------
  LF.enqueueJob({ kind: "from-a-newer-build", targetId: A, label: "TestQ Alpha" });
  LF.enqueueJob({ kind: "node-check", targetId: B, label: "TestQ Beta" });
  await sleep(20);
  check("a request this build has no pass for is dropped, not left in the way",
        log[log.length - 1] === "start:" + B && !LF.jobFor(A, "from-a-newer-build"), log.join(" "));
  release(B);
  await sleep(10);

  // ---------- 7. the buttons go through it ----------
  const src = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
  check("the card's own check asks the queue rather than starting a pass",
        /function recheckNodeNow\(n, el\) \{[\s\S]{0,600}?return enqueueLlmJob\(spec, null, el\);/.test(src));
  check("...so does the nameplate re-check, both depths",
        /kind: deep \? "family-recheck-deep" : "family-recheck"/.test(src));
  check("...generation research",
        /function runGenerationResearch\(gen, el\) \{\s*\n\s*return enqueueLlmJob\(\{ kind: "gen-research"/.test(src));
  check("...reading an engine's article",
        /function scanEngine\(title, btn, node\) \{[\s\S]{0,400}?kind: "engine-read"/.test(src));
  check("...and the automatic check that fires when a card is opened",
        /if \(!llmCheckOn\) return;[\s\S]{0,500}?kind: "node-check"/.test(src));
  check("every pass a runner drives returns a promise, or the queue cannot tell when it is over",
        /return run\.then\(r => \{/.test(src) &&
        /return LF\.researchGeneration\(gen, fam, nodes, links\)\.then/.test(src) &&
        /return LF\.forceRecheckFamily\(/.test(src) &&
        /await deepRecheckGenerations\(fam, row\);/.test(src));

  // ---------- 8. recovery ----------
  // A job that was mid-pass when the page went away. resumeJobs puts it back
  // in the queue rather than losing it -- and does NOT start it, because the
  // agent's page has to stamp its decisions before anything runs. See
  // llm_families.js's jobsAllowed.
  LF.enqueueJob({ kind: "node-check", targetId: A, label: "TestQ Alpha" });
  await sleep(10);
  check("a job is running before the simulated crash", !!LF.runningJob(), ids());
  const r = LF.resumeJobs();
  check("an interrupted request is put back in the queue, not lost",
        r.recovered === 1 && r.waiting === 1 && !LF.runningJob(), JSON.stringify(r) + " / " + ids());
  const lfSrc = fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8");
  check("...and nothing runs until something says go",
        /if \(jobPumping \|\| !jobsAllowed\) return;/.test(lfSrc) &&
        /function startJobs\(\) \{ jobsAllowed = true;/.test(lfSrc));
  check("a real browser says go once boot is done",
        /if \(!\/\[\?&\]agent=1\(\?:&\|\$\)\/\.test\(location\.search\) && window\.LlmFamilies\.startJobs\)/.test(src));

  // ---------- 9. the panel ----------
  const btn = window.document.getElementById("llmqueuebtn");
  const panel = window.document.getElementById("llmqueue-panel");
  check("the Tools menu offers the queue when serve.py is answering", !!btn && !btn.hidden);
  btn.onclick(new window.Event("click"));
  check("...and opening it lists what is in the queue",
        !panel.hidden && /Alpha/.test(window.document.getElementById("llmqueue-list").textContent),
        window.document.getElementById("llmqueue-list").textContent.trim().slice(0, 80));
  const dropBtn = window.document.querySelector("#llmqueue-list .lrq-drop");
  check("...with a way to withdraw one", !!dropBtn);
  dropBtn.onclick();
  check("...which actually removes it", LF.jobs().length === 0, ids());
  check("...and the dot goes out when nothing is outstanding",
        window.document.getElementById("llmqueue-dot").hidden === true);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
