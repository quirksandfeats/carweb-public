// Real bug report: "when doing the LLM search from the user, the cars that it
// made a match with, for example, in the dacia duster, it didn't look at
// expanding the models into nameplates. For example, the Renault Captur was
// found to be a match. According to my cascading rule of 1, the captur should
// also be fully expanded into its nameplate and also find the multiple
// generations, but in this case it wasn't, and was only left as a model.
// That's what the level 1 cascading represents, where level 0 is the dacia
// duster."
//
// Two halves, both proven here.
//
// 1. THE CASCADE ITSELF. A seed's article names several cars that already
//    exist in the graph as plain models. Each of them is one hop out, so each
//    gets its own generation check and, if it hides generations, becomes a
//    real nameplate -- not just a relation line to a model left as it was.
//
// 2. KNOWING WHEN THAT IS FINISHED. The real run did schedule those checks;
//    the agent shut the browser and llama-server down while they were still
//    running, because it decided a cascade was over by watching the number of
//    stored entries stop changing for a minute -- and one check writes
//    nothing at all for its whole duration. pendingWork() is the honest
//    answer instead: what is in flight, what is queued behind it, and what is
//    still waiting on an article lookup. The agent's settle waits on that now,
//    so this asserts it is non-zero while the cascade is working and empty
//    only once it genuinely is.
//
// 3. AND SAYING SO ON SCREEN. "I must have been misled into closing the
//    server, since I no longer saw any new operations occur." Same silence,
//    seen from the browser instead of the terminal: a page with five cars
//    still to get through looks exactly like a finished one. #llmbusy names
//    what is being worked on for as long as anything is.
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

// The seed and its three named partners, shaped like the real report: the
// seed's own article names them, each already exists as a plain model, and
// each of their own articles turns out to hold two generations.
const SEED = "m-test-casc-duskar", MAKE = "mk-test-casc";
const PARTNERS = ["m-test-casc-capvor", "m-test-casc-loganto", "m-test-casc-kixby"];
const LABELS = { "m-test-casc-capvor": "Capvor", "m-test-casc-loganto": "Loganto", "m-test-casc-kixby": "Kixby" };

const SEED_WT = "{{Infobox automobile|name=TestCasc Duskar}}\n" +
  "== First generation (HSX; 2010) ==\nThe HSX shared its platform with the TestCasc Capvor, " +
  "the TestCasc Loganto and the TestCasc Kixby.\n" +
  "== Second generation (HMX; 2017) ==\nThe HMX continued on the same platform.\n";
const partnerWt = label =>
  `{{Infobox automobile|name=TestCasc ${label}}}\n` +
  `== First generation (${label}1; 2013) ==\nThe ${label}1 launched in 2013.\n` +
  `== Second generation (${label}2; 2019) ==\nThe ${label}2 followed in 2019.\n`;

function llm(payload, delayMs) {
  return new Promise(r => setTimeout(() => {
    r({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) });
  }, delayMs));
}

window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    const label = Object.values(LABELS).find(l => decodeURIComponent(u).includes(l));
    const wt = label ? partnerWt(label) : SEED_WT;
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    const txt = JSON.stringify(JSON.parse(opts.body).messages);
    if (txt.includes("You check whether a mentioned car")) {
      return llm({ matchId: null, confidence: "low", reason: "nothing extra found" }, 5);
    }
    if (txt.includes("You extract car production-generation data")) {
      const label = /Duskar/.test(txt) ? null : Object.values(LABELS).find(l => txt.includes(l));
      // A partner check is deliberately SLOW here -- that is the whole point.
      // It writes nothing for its entire duration, which is exactly what the
      // old entry-counting settle mistook for the cascade being over.
      if (label) {
        return llm({ hasMultipleGenerations: true, generations: [
          { code: label + "1", yearStart: 2013, yearEnd: 2019, designers: [], engineers: [], sharedPlatforms: [] },
          { code: label + "2", yearStart: 2019, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] },
        ] }, 150);
      }
      return llm({ hasMultipleGenerations: true, generations: [
        { code: "HSX", yearStart: 2010, yearEnd: 2017, designers: [], engineers: [],
          sharedPlatforms: ["TestCasc Capvor", "TestCasc Loganto", "TestCasc Kixby"] },
        { code: "HMX", yearStart: 2017, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] },
      ] }, 5);
    }
    return llm({}, 5);
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
DATA.nodes.push({ id: MAKE, type: "make", label: "TestCasc", year: 1960 });
DATA.nodes.push({ id: SEED, type: "model", label: "Duskar", make: "TestCasc",
                  wp: "TestCasc Duskar", year: 2010, end: null });
DATA.links.push({ source: SEED, target: MAKE, type: "made" });
PARTNERS.forEach(id => {
  DATA.nodes.push({ id, type: "model", label: LABELS[id], make: "TestCasc",
                    wp: "TestCasc " + LABELS[id], year: 2013, end: null });
  DATA.links.push({ source: id, target: MAKE, type: "made" });
});

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, rejectedRelations: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

const cw = window.CarWeb;
cw.boot();
cw.setYearRange(1900, cw.yearRange().max);
const LF = window.LlmFamilies;

check("the cascade budget for this run is at least one hop", LF.cascadeMaxDepth() >= 1, LF.cascadeMaxDepth());
check("nothing is outstanding on a page nobody has asked anything of yet",
      LF.pendingWork().total === 0, JSON.stringify(LF.pendingWork()));
const busy = window.document.getElementById("llmbusy");
check("...and nothing claims to be working on it", busy && busy.hidden === true);

cw.setLlmCheck(true);
cw.openDetail(cw.byId.get(SEED));

(async () => {
  // Catch the moment the seed is done but its partners are not: the entry
  // count has stopped moving and there is still real work running. That gap
  // is what the agent used to walk out on.
  let sawPendingAfterSeed = false, sawBusyShown = false, busySaidWhat = "";
  for (let i = 0; i < 3000; i++) {
    await sleep(20);
    const seed = LF.entryFor(SEED);
    if (LF.pendingWork().total > 0 && !busy.hidden) {
      sawBusyShown = true;
      busySaidWhat = window.document.getElementById("llmbusy-text").textContent;
    }
    if (seed && seed.status === "confirmed" && LF.pendingWork().total > 0) sawPendingAfterSeed = true;
    if (seed && seed.status === "confirmed" && LF.pendingWork().total === 0 &&
        PARTNERS.every(id => LF.entryFor(id))) break;
  }

  check("the seed itself was split", (LF.entryFor(SEED) || {}).status === "confirmed",
        (LF.entryFor(SEED) || {}).status);
  check("the page reports outstanding work while the partners are still being "
        + "checked -- the window the old entry-counting settle mistook for 'finished'",
        sawPendingAfterSeed);

  PARTNERS.forEach(id => {
    const n = cw.byId.get(id), e = LF.entryFor(id);
    check(`${LABELS[id]} was checked, not just linked to`, !!e, e && e.status);
    check(`...and expanded into a real nameplate with its own generations`,
          n.type === "family" && (n.generations || []).length === 2,
          n.type + "/" + (n.generations || []).length);
    check(`...at one hop from the seed, which is what depth 1 means`,
          LF.cascadeDepthOf(id) === 1, LF.cascadeDepthOf(id));
  });

  check("and once they are all done nothing is left outstanding",
        LF.pendingWork().total === 0, JSON.stringify(LF.pendingWork()));
  check("the page said so on screen while the work was going on -- an idle-"
        + "LOOKING page is what got serve.py stopped mid-check",
        sawBusyShown, busySaidWhat);
  check("...and it named a car rather than showing a bare spinner",
        /Duskar|Capvor|Loganto|Kixby|queued|next check/.test(busySaidWhat), busySaidWhat);
  // The label is on a timer rather than a notification (see initLlmBusy), so
  // it can be up to one tick stale -- give it a couple before asking.
  for (let i = 0; i < 20 && !busy.hidden; i++) await sleep(100);
  check("...and it goes away once there is genuinely nothing left",
        busy.hidden === true, busy.hidden + " / " + busy.textContent.trim());
  check("pendingWork names what it is waiting on, so the terminal can say so",
        Array.isArray(LF.pendingWork().checks) && Array.isArray(LF.pendingWork().partners) &&
        Array.isArray(LF.pendingWork().lookups));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
