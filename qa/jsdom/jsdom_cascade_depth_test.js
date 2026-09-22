// How far one click is allowed to cascade.
//
// Real user question: "does this code essentially just check the current model
// selected and its directly related models... [or does it also do] yet another
// (unintended) additional nameplate which is related to the nameplate that the
// original model was related to?"
//
// It was the latter, without limit, and the recursion is easy to miss: applying
// a partner's generation split runs the same related-car discovery over ITS
// generations, which schedules a check on ITS partners, which when applied
// does the same again. The only brakes were incidental ("each car is checked
// at most once ever", a serial queue) -- never a depth limit. Measured on this
// exact A->B->C->D->E fixture before the fix: clicking A alone fetched,
// checked and split all five.
//
// Default is now one hop, configured server-side (serve.py's
// CASCADE_MAX_DEPTH, delivered via __config on the same GET that seeds the
// store). The scenarios below pin down all three properties that matter:
// the default stops at one hop, the second-hop car is still fully checkable
// by clicking it directly (so nothing is lost), and raising the limit really
// does go further.
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

// A -> B -> C -> D -> E: each car's article names ONLY the next one, so the
// number of cars checked is exactly the depth reached.
const CHAIN = ["Aay", "Beey", "Ceey", "Deey", "Eeey"];
const idFor = c => "m-testchain-" + c.toLowerCase();

function run(cascadeMaxDepth) {
  const checked = [];
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      const m = decodeURIComponent(u).match(/page=([^&]+)/);
      const title = m ? m[1].replace(/\+/g, " ").replace(/_/g, " ") : "";
      const i = CHAIN.findIndex(c => title === "TestChain " + c);
      const next = i >= 0 && i + 1 < CHAIN.length ? CHAIN[i + 1] : null;
      const wt = i < 0 ? "A car."
        : `The ${CHAIN[i]} was built as the ${CHAIN[i]}1 and the ${CHAIN[i]}2.` +
          (next ? ` It shares its platform with the TestChain ${next}.` : "") +
          `\n== ${CHAIN[i]}1 ==\nfirst.\n== ${CHAIN[i]}2 ==\nsecond.`;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const sys = String(body.messages[0].content), user = String(body.messages[1].content);
      if (sys.includes("You extract car production-generation data")) {
        const mm = user.match(/^Car:\s*TestChain\s+(\w+)/);
        const c = mm ? mm[1] : null;
        if (c) checked.push(c);
        const i = CHAIN.indexOf(c);
        const next = i >= 0 && i + 1 < CHAIN.length ? CHAIN[i + 1] : null;
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: true,
          generations: [
            { code: c + "1", yearStart: 2000, yearEnd: 2010, designers: [], engineers: [], sharedPlatforms: [] },
            { code: c + "2", yearStart: 2010, yearEnd: null, designers: [], engineers: [],
              sharedPlatforms: next ? ["TestChain " + next] : [] },
          ],
        }) } }] }) });
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
  const DATA = window.CARDATA;
  DATA.nodes.push({ id: "mk-testchain", type: "make", label: "TestChain", year: 1950 });
  CHAIN.forEach(c => {
    DATA.nodes.push({ id: idFor(c), type: "model", label: c, make: "TestChain", wp: "TestChain " + c, year: 2000, end: null });
    DATA.links.push({ source: idFor(c), target: "mk-testchain", type: "made" });
  });
  // Exactly the shape serve.py's GET /api/llm-families now returns.
  window.LLM_FAMILIES = {
    families: {}, relations: {}, recheck: {},
    __serverAvailable: true, __config: { cascadeMaxDepth },
  };
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  cw.setLlmCheck(true);
  return { window, cw, checked, split: () => CHAIN.filter(c => cw.byId.get(idFor(c)).type === "family") };
}

(async () => {
  // ---------- default: one hop ----------
  console.log("--- default (one hop): the clicked car and its direct partners, nothing further ---");
  {
    const { cw, checked, split } = run(1);
    check("the configured budget reached the client", window.LlmFamilies.cascadeMaxDepth() === 1,
      window.LlmFamilies.cascadeMaxDepth());
    cw.openDetail(cw.byId.get(idFor("Aay")));      // the user clicks ONE car
    await sleep(1200);

    check("the clicked car was checked", checked.includes("Aay"), JSON.stringify(checked));
    check("its DIRECT partner was checked too -- one hop still works", checked.includes("Beey"), JSON.stringify(checked));
    check("the second-hop car was NOT checked (this is the whole fix)", !checked.includes("Ceey"), JSON.stringify(checked));
    check("...nor anything beyond it", !checked.includes("Deey") && !checked.includes("Eeey"), JSON.stringify(checked));
    check("exactly two cars were checked", checked.length === 2, JSON.stringify(checked));
    check("both got split", split().join(",") === "Aay,Beey", JSON.stringify(split()));
    // Nothing is lost: the second-hop car is still linked, still checkable.
    check("the un-cascaded car is still a normal, checkable model",
      window.LlmFamilies.isEligible(cw.byId.get(idFor("Ceey"))));
    check("...and has no verdict recorded, so clicking it runs a real check",
      !window.LlmFamilies.entryFor(idFor("Ceey")));

    // ---------- and clicking it directly makes it an origin in its own right ----------
    checked.length = 0;
    // Re-arm first: 🤖 LLM Check deliberately disengages itself the moment a
    // check starts (see app.js's disengageLlmCheckFor -- "on by itself, it's
    // too easy to rack up unintended llama.cpp calls just by browsing from car
    // to car"), so a real user turns it back on before probing the next car.
    cw.setLlmCheck(true);
    cw.openDetail(cw.byId.get(idFor("Ceey")));
    await sleep(1200);
    check("clicking the second-hop car checks it", checked.includes("Ceey"), JSON.stringify(checked));
    check("...and cascades one hop from THERE", checked.includes("Deey"), JSON.stringify(checked));
    check("...but still stops after one hop", !checked.includes("Eeey"), JSON.stringify(checked));
  }

  // ---------- raised limit really does go further ----------
  console.log("\n--- CASCADE_MAX_DEPTH=2: one more hop, and still bounded ---");
  {
    const { cw, checked } = run(2);
    cw.openDetail(cw.byId.get(idFor("Aay")));
    await sleep(1600);
    check("the raised budget reached the client", window.LlmFamilies.cascadeMaxDepth() === 2);
    check("three cars checked: the click, its partner, and that partner's partner",
      checked.length === 3, JSON.stringify(checked));
    check("...and it still stops there rather than running away",
      !checked.includes("Deey") && !checked.includes("Eeey"), JSON.stringify(checked));
  }

  // ---------- 0 disables the automatic partner check entirely ----------
  console.log("\n--- CASCADE_MAX_DEPTH=0: only ever the car you clicked ---");
  {
    const { cw, checked } = run(0);
    cw.openDetail(cw.byId.get(idFor("Aay")));
    await sleep(1200);
    check("only the clicked car was checked", checked.length === 1 && checked[0] === "Aay", JSON.stringify(checked));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();

// Real bug report: one click on the Mercedes G-Class, depth limit 1, walked
// into the Chevrolet Cobalt, Opel Astra, Golf GTI and KSU Gazal-1 -- none of
// which that article mentions -- and would not stop.
//
// The partner budget was fine. The hole was minting: a car discovered mid-check
// and created on the spot was checked with no depth recorded, so depthOf() read
// 0 for it -- the same as the car the user clicked -- and the walk renewed its
// own allowance at every hop.
{
  const src = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "..", "app", "llm_families.js"), "utf-8");
  check("a minted car is given a depth before it can be checked",
    /const mintedDepth = /.test(src) && /cascadeDepth\.set\(node\.id, mintedDepth\)/.test(src));
  check("...and the budget is enforced on it, like any other hop",
    /if \(mintedDepth > cascadeMaxDepth\) return;/.test(src));
  // The whole function, not a fixed slice of it: a comment added above the
  // line this looks for once pushed it past the cut and failed the check on
  // code whose order had not changed.
  const at = src.indexOf("function scheduleWpLookupAndCheck");
  const fn = src.slice(at, src.indexOf("\n  }\n", at));
  const budget = fn.indexOf("mintedDepth > cascadeMaxDepth");
  check("...before any check is scheduled for it, not after",
    budget > 0 && fn.indexOf("wpLookupScheduled.add") > budget, "order");
  check("...including a car whose article is already known, which goes straight to its check",
    budget > 0 && fn.indexOf("queuePartnerCheck(") > budget, "order");

  const app = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "..", "app", "app.js"), "utf-8");
  check("generation freshening is inside the same budget",
    /cascadeAllowedFrom && !LF\.cascadeAllowedFrom\(c\.famA\.id\)\) continue;/.test(app));
}
// What depth 1 is supposed to mean, in the user's own words: "it checks itself
// (depth 0) and then checks all cars that have some kind of relation ... and
// should reveal the information about the connected cars to the initially
// selected car. Other than that, the search should stop."
//
// The earlier fix measured a newly-created car's distance from the car the
// user last CLICKED, so a car discovered while checking a partner still came
// out at depth 1 and got checked -- one hop further than asked for.
{
  const src = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "..", "app", "llm_families.js"), "utf-8");
  check("a newly-created car's distance is measured from the car whose check found it",
    /depthOf\(originId \|\| engagedId\) \+ 1/.test(src));
  check("...and the discovering car is actually passed in, not assumed",
    /mintRelatedNode\(nodes, links, mentionText, makeVariant, famId\)/.test(src) &&
    /scheduleWpLookupAndCheck\(modelNode, nodes, originId\)/.test(src));
  check("...while a car that already has a distance keeps it",
    /cascadeDepth\.has\(node\.id\)\s*\n?\s*\? cascadeDepth\.get\(node\.id\)/.test(src));
}
console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nALL GREEN");
process.exit(fails ? 1 : 0);
