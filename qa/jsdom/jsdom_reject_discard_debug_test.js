// Verifies three behaviors:
//  1. A first-time nameplate creation (a plain model the LLM finds hides
//     multiple generations) auto-applies immediately -- no Yes/No approval
//     step at all. Real user request: "if a car is creating a nameplate for
//     the first time... you do not need my approval to turn it into a
//     nameplate. Simply do so without my request." (Older behavior, now
//     retired: a "provisional" proposal sat there needing a Yes/No decision,
//     and "No" forgot the check entirely + turned off LLM Check mode.)
//  2. Which in-flight checks survive being walked away from, and which don't.
//     This rule was REVERSED for user-initiated checks by a later real bug
//     report -- Andy's Opel Astra run: "I just tried doing an llm search for
//     the Opel Astra... However, when the scanning was going through, it was
//     clear that nothing was changing in the knowledge graph." Two full
//     checks, ~100 seconds each, both producing a complete generation
//     proposal, and nothing saved: the result was only ever held in memory,
//     and only while that exact car's panel was still open when it came back.
//     His log showed the page reloading mid-run, which silently binned it.
//
//     So the contract now splits by WHO ASKED. A check the user initiated --
//     the 🤖 LLM Check toggle aimed at one car (it disengages itself after
//     kicking off exactly one, so it is a per-car request, not a browsing
//     mode), the per-car re-check button, or pasting a Wikipedia link and
//     asking for a check -- is written to disk and survives navigation, a
//     reload, anything. A check nobody asked for -- one the cascade schedules
//     on a partner car while discovering relationships -- is still held in
//     memory only while provisional, so idle discovery can never pile up
//     proposals on disk. Both halves are asserted below.
//  3. The debug panel's underlying API: allEntries/deleteEntry/resetAll.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;

function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

// A real fetch stub: Wikipedia wikitext + an Ollama proxy response, so
// checkNode() runs to a genuine "provisional" completion (not an error
// shortcut), and every /api/llm-families POST is logged so we can assert
// nothing gets written while a check is still in flight.
let posts = [];
const WIKITEXT = "{{Infobox automobile|name=Test Car}}\n== Second generation (2012-2020) ==\nThe second generation was launched in 2012.\n== Third generation (2020-present) ==\nThe third generation was launched in 2020.\n";
let ollamaCallCount = 0;
window.fetch = (url, opts) => {
  if (typeof url === "string" && url.includes("action=parse")) {
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
  }
  if (url === "/api/llm/chat") {
    ollamaCallCount++;
    const payload = {
      hasMultipleGenerations: true,
      generations: [
        { code: "Second generation", yearStart: 2012, yearEnd: 2020, designers: [], engineers: [] },
        { code: "Third generation", yearStart: 2020, yearEnd: null, designers: [], engineers: [] },
      ],
    };
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) });
  }
  if (url === "/api/llm-families" && opts && opts.method === "POST") {
    posts.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};

window.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { this.status = 200; this.responseText = JSON.stringify({ families: {} }); };
};

global.window = window;
global.document = window.document;
function loadScript(file) { window.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
(function () {
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = xhr.status === 200 ? JSON.parse(xhr.responseText) : { families: {} };
  data.__serverAvailable = xhr.status === 200;
  window.LLM_FAMILIES = data;
})();
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
  loadScript("platforms.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  window.CarWeb.boot();
  const LOGAN = "m-dacia-logan";
  const GALAXY = "m-ford-galaxy";

  // ---------- scenario 1: first-time creation auto-applies, no approval ----------
  console.log("--- scenario 1: auto-apply, no approval needed ---");
  window.CarWeb.setLlmCheck(true);
  const logan = window.CarWeb.byId.get(LOGAN);
  window.CarWeb.openDetail(logan);
  await sleep(50); // let checkNode's real promise chain (and the new auto-apply) resolve
  check("no Yes/No review box ever appears", !window.document.querySelector(".llm-yes") && !window.document.querySelector(".llm-no"));
  check("entry auto-confirmed", window.LlmFamilies.entryFor(LOGAN) && window.LlmFamilies.entryFor(LOGAN).status === "confirmed");
  check("the plain model itself became a real family, with no click required", logan.type === "family", logan.type);
  check("the auto-apply was actually persisted to disk", posts.length > 0 && posts[posts.length - 1].families && posts[posts.length - 1].families[LOGAN] && posts[posts.length - 1].families[LOGAN].status === "confirmed");
  // Real behavior change: selecting Logan (a fresh check) now auto-
  // disengages LLM Check right away, by design -- see app.js's
  // disengageLlmCheckFor. Nothing here is a rejection signal either way;
  // the entry above still shows "confirmed" regardless of the toggle.
  check("LLM Check auto-disengages once a check is kicked off (by design, not a rejection signal)", window.CarWeb.llmCheckOn() === false);

  // ---------- scenario 2a: a check the USER asked for survives walking away ----------
  // The Opel Astra report, as a regression test. Arming 🤖 LLM Check and
  // clicking one car is a request for that car -- the toggle turns itself off
  // again immediately (see app.js's disengageLlmCheckFor), so it is one
  // deliberate search, not a browsing mode -- and a minute of work must not be
  // thrown away because the panel closed or the page reloaded while it ran.
  console.log("--- scenario 2a: close panel before the in-flight check resolves ---");
  window.CarWeb.setLlmCheck(true);
  const galaxy = window.CarWeb.byId.get(GALAXY);
  window.CarWeb.openDetail(galaxy); // kicks off a real (mocked) async checkNode call
  window.document.getElementById("detail-close").onclick(); // walk away SYNCHRONOUSLY, before any promise/microtask has a chance to resolve
  await sleep(50); // now let the check finish in the background
  const galaxyEntry = window.LlmFamilies.entryFor(GALAXY);
  check("a check the user asked for is KEPT even though they walked away", !!galaxyEntry,
    JSON.stringify(galaxyEntry));
  check("...and written to disk, so it survives a reload too",
    posts.some(p => p.families && p.families[GALAXY]),
    JSON.stringify(posts.length));

  // ---------- scenario 2b: and it is not re-run from scratch afterwards ----------
  // The other half of the same complaint: the Astra was checked twice, ~100
  // seconds each, because the first answer was discarded and nothing
  // remembered it had already been asked.
  console.log("--- scenario 2b: the same car is not checked all over again ---");
  const callsBefore2b = ollamaCallCount;
  window.CarWeb.setLlmCheck(true);
  window.CarWeb.openDetail(galaxy);
  window.CarWeb.openDetail(logan); // switch away again
  await sleep(50);
  check("re-opening the car does NOT spend another minute asking the same question",
    ollamaCallCount === callsBefore2b, `${callsBefore2b} -> ${ollamaCallCount}`);
  check("...because the first answer is still on record", window.LlmFamilies.entryFor(GALAXY) !== null);

  // ---------- scenario 2c: a check NOBODY asked for is still discarded ----------
  // The protection the rule above must not trample: while the cascade explores
  // a car's partners it checks cars the user never selected, and a provisional
  // proposal from one of those is held in memory only. Otherwise idle
  // discovery would quietly fill the store with proposals nobody wants.
  console.log("--- scenario 2c: a background cascade check is still not persisted ---");
  const windstar = window.CarWeb.byId.get("m-ford-windstar");
  if (windstar) {
    const postsBefore2c = posts.length;
    window.LlmFamilies.setEngaged(null);   // nobody is looking at anything
    const cascadeEntry = await window.LlmFamilies.checkNodeCascade(windstar, window.CarWeb.nodes);
    check("(fixture) the background check really did produce a provisional proposal",
      cascadeEntry && cascadeEntry.status === "provisional", cascadeEntry && cascadeEntry.status);
    check("a provisional proposal nobody asked for is never written to disk",
      !posts.slice(postsBefore2c).some(p => p.families && p.families["m-ford-windstar"] &&
        p.families["m-ford-windstar"].status === "provisional"),
      `${posts.length - postsBefore2c} writes since`);
  } else {
    check("(fixture) a spare car exists for the background-check case", false, "m-ford-windstar missing");
  }

  // ---------- scenario 3: debug panel API, using Logan's already-confirmed entry from scenario 1 ----------
  console.log("--- scenario 3: debug panel API ---");
  const entries = window.LlmFamilies.allEntries();
  check("allEntries() lists the confirmed car", entries.some(e => e.id === LOGAN), JSON.stringify(entries));

  const debugBtn = window.document.getElementById("llmdebugbtn");
  check("debug button is visible now that there's something to show", debugBtn.hidden === false);
  debugBtn.onclick();
  const panel = window.document.getElementById("llmdebug");
  check("debug panel opens", panel.hidden === false);
  // Dropdown option values are namespaced "gen:<id>" / "recheck:<id>" now --
  // the debug panel lists BOTH the generation-check layer (store.families)
  // and the separate nameplate generation-list-override layer
  // (store.recheck, see jsdom_family_recheck_test.js) in one dropdown, and
  // needs to know which store a delete should route to.
  const opt = [...window.document.querySelectorAll("#llmdebug-select option")].find(o => o.value === "gen:" + LOGAN);
  check("Dacia Logan appears in the delete-one dropdown", !!opt, opt && opt.textContent);

  await window.LlmFamilies.deleteEntry(LOGAN);
  check("deleteEntry() removes it", window.LlmFamilies.entryFor(LOGAN) === null);
  check("delete was persisted to disk", posts[posts.length - 1] && !("m-dacia-logan" in posts[posts.length - 1].families));

  // The in-session graph (this same tab) correctly stays a family after a
  // debug delete -- the confirm already mutated the live node in place, and
  // undoing THAT is exactly what the real debug button's location.reload()
  // is for (deliberately not simulated here; jsdom navigation is a can of
  // worms and the disk-level guarantee below is the part that matters).
  // Confirm it from the other end instead: a FRESH boot (a new window/tab,
  // seeded from the now-current, post-delete on-disk state) sees a plain,
  // re-checkable model again -- exactly what reloading the real page does.
  const latestPosted = posts[posts.length - 1];
  const dom2 = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const window2 = dom2.window;
  window2.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window2.requestAnimationFrame = () => 1;
  window2.devicePixelRatio = 1;
  window2.Element.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect;
  Object.defineProperty(window2.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window2.fetch = window.fetch;
  window2.XMLHttpRequest = function () {
    this.open = () => {};
    this.send = () => { this.status = 200; this.responseText = JSON.stringify(latestPosted); };
  };
  (function () {
    const xhr = new window2.XMLHttpRequest();
    xhr.open("GET", "/api/llm-families", false);
    xhr.send(null);
    const data = JSON.parse(xhr.responseText);
    data.__serverAvailable = true;
    window2.LLM_FAMILIES = data;
  })();
  const g = global.window;
  global.window = window2; global.document = window2.document;
  window2.eval(fs.readFileSync(path.join(APP, "d3.min.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "data.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "app.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "timeline.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "sixdeg.js"), "utf-8"));
  window2.eval(fs.readFileSync(path.join(APP, "platforms.js"), "utf-8"));
  window2.CarWeb.boot();
  const logan2 = window2.CarWeb.byId.get(LOGAN);
  check("a fresh boot after the debug delete sees Dacia Logan as a plain model again", logan2.type === "model", logan2.type);
  window2.CarWeb.setLlmCheck(true); // separate jsdom instance -> separate localStorage, starts off
  window2.CarWeb.openDetail(logan2);
  await sleep(50);
  check("...and it's re-checkable from scratch, auto-applying again with no approval needed", logan2.type === "family", logan2.type);
  global.window = g; global.document = g.document;

  await window.LlmFamilies.resetAll();
  check("resetAll() clears everything", window.LlmFamilies.allEntries().length === 0);
  check("resetAll() persisted an empty store", Object.keys(posts[posts.length - 1].families).length === 0);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}
main();
