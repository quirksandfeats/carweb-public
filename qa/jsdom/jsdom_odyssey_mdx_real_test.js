// The Honda Odyssey / Acura MDX report, reproduced against the REAL graph
// nodes rather than a synthetic fixture.
//
// Real user report: "It seems that the LLM doesn't properly find the
// generations for other nameplates. For example, I selected the Honda Odyssey
// Nameplate, and saw that it made a connection [to] the Acura MDX. In this
// case, the LLM should have also looked at the Acura MDX and also checked its
// wikipedia page and search for generations, and split up the Acura MDX into
// generations, to then make the links between the generations of the Acura
// MDX nameplate and the Honda Odyssey nameplate."
//
// Why the real nodes matter here: in the shipped dataset there is NO
// pre-existing graph link between the Odyssey and the MDX at all (the only
// paths between them run through the Honda Avancier). So this pair can only
// ever reach the relation panel through the `relationsTouching` merge -- a
// provisional entry that resolveOnePlatformMention wrote with no graph link
// behind it -- not through the ordinary adjacency scan that every other
// relation test exercises. A synthetic fixture with a convenient pre-existing
// `related` link would test the wrong code path entirely and pass while the
// reported bug remained.
//
// Both real nodes also start out as plain, ungrouped models with no
// generations, which is exactly the starting state the report describes.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

const ODYSSEY = "m-honda-odyssey-north-america";
const MDX = "m-acura-mdx";
const ODYSSEY_WP = "Honda Odyssey (North America)";
const MDX_WP = "Acura MDX";

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

// Stand-in article text. The Odyssey's names the MDX as a related car (which
// is what creates the connection at all); the MDX's describes its own four
// generations, which is the thing that was being found and then discarded.
const ODYSSEY_TEXT = [
  "{{Infobox automobile | related = Acura MDX }}",
  "The Odyssey has been sold as the RA, the RL and the RM.",
  "It shares its platform with the Acura MDX.",
  "== RA ==\nThe RA ran from 1994.",
  "== RL ==\nThe RL followed in 1999.",
  "== RM ==\nThe RM arrived in 2011.",
].join("\n");
const MDX_TEXT = [
  "The Acura MDX has been built as the YD1, YD2, YD3 and YD4.",
  "== YD1 ==\nThe YD1 ran 2000-2006.",
  "== YD2 ==\nThe YD2 followed in 2006.",
  "== YD3 ==\nThe YD3 arrived in 2013.",
  "== YD4 ==\nThe YD4 is current.",
].join("\n");

const llmCalls = [];
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
    const wt = title === MDX_WP ? MDX_TEXT : title === ODYSSEY_WP ? ODYSSEY_TEXT : "A car.";
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    const sys = String(body.messages[0].content);
    const user = String(body.messages[1].content);
    llmCalls.push({ purpose: body.purpose || null, user: user.slice(0, 80) });
    if (sys.includes("You extract car production-generation data")) {
      // Match on the prompt's own "Car: <make> <label>" opening line, NOT on
      // "MDX" appearing anywhere -- the Odyssey's article text names the MDX
      // as a related car, so a loose check hands the Odyssey the MDX's
      // generation list, which validate() then correctly drops as not present
      // in the Odyssey's article. (Caught by this test on its first run.)
      if (/^Car:\s*Acura MDX/.test(user)) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: true,
          generations: ["YD1", "YD2", "YD3", "YD4"].map((c, i) => ({
            code: c, yearStart: [2000, 2006, 2013, 2021][i], yearEnd: [2006, 2013, 2021, null][i],
            designers: [], engineers: [], sharedPlatforms: [],
          })),
        }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: true,
        generations: ["RA", "RL", "RM"].map((c, i) => ({
          code: c, yearStart: [1994, 1999, 2011][i], yearEnd: [1999, 2011, null][i],
          designers: [], engineers: [],
          // The mention that creates the connection in the first place.
          sharedPlatforms: i === 2 ? ["Acura MDX"] : [],
        })),
      }) } }] }) });
    }
    if (sys.includes("car manufacturer named in a Wikipedia sentence")) {
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ matchId: null, confidence: "low", reason: "n/a" }) } }] }) });
    }
    if (sys.includes("whether a mentioned car already exists")) {
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ matchId: null, confidence: "low", reason: "n/a" }) } }] }) });
    }
    // The relation disambiguation, once both sides are real nameplates.
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      resolved: true, codeA: "Odyssey (North America) RM", codeB: "MDX YD3",
      reason: "Both articles name this specific platform pairing.",
    }) } }] }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window;
global.document = window.document;
const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
load("d3.min.js");
load("data.js");
// A clean LLM layer, so this is genuinely "checking these two cars for the
// first time" rather than replaying whatever is on disk today.
window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
load("llm_families.js");
load("app.js");
load("timeline.js");
load("sixdeg.js");
load("platforms.js");

(async () => {
  const cw = window.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);

  const odyssey = cw.byId.get(ODYSSEY), mdx = cw.byId.get(MDX);
  check("the real Honda Odyssey node exists (precondition)", !!odyssey, odyssey && odyssey.label);
  check("the real Acura MDX node exists (precondition)", !!mdx, mdx && mdx.label);
  check("both start as plain, ungrouped models -- the reported starting state",
    odyssey.type === "model" && !odyssey.familyOf && mdx.type === "model" && !mdx.familyOf);
  // The point of using real nodes: there is no link between them to scan.
  const idOf = v => (typeof v === "string" ? v : (v && v.id));
  const preexisting = cw.links.filter(l => !l.retired &&
    ((idOf(l.source) === ODYSSEY && idOf(l.target) === MDX) || (idOf(l.source) === MDX && idOf(l.target) === ODYSSEY)));
  check("there is NO pre-existing graph link between them, so this can only reach the panel as a provisional entry",
    preexisting.length === 0, preexisting.length);

  // ---------- the reported action: turn LLM Check on and open the Odyssey ----------
  cw.setLlmCheck(true);
  cw.openDetail(odyssey);
  await sleep(400); // generation check -> auto-apply -> partner cascade -> relation check

  check("the Odyssey was split into a real nameplate", odyssey.type === "family", odyssey.type);
  check("...with its three generations", (odyssey.generations || []).length === 3, JSON.stringify(odyssey.generations));

  // ---------- the actual bug: was the PARTNER searched too? ----------
  check("the Acura MDX's OWN Wikipedia article was fetched",
    llmCalls.some(c => c.user.includes("MDX")), JSON.stringify(llmCalls.map(c => c.purpose)));
  check("the Acura MDX was split into a real nameplate as well", mdx.type === "family", mdx.type);
  check("...with all four of its own generations minted",
    (mdx.generations || []).length === 4, JSON.stringify(mdx.generations));
  check("...each a live node in the graph",
    (mdx.generations || []).every(id => cw.byId.get(id) && !cw.byId.get(id).retired));

  // ---------- and the connection made generation-to-generation ----------
  const entries = window.LlmFamilies.allRelationEntries()
    .filter(e => [e.famA, e.famB].includes(ODYSSEY) && [e.famA, e.famB].includes(MDX));
  check("a relation entry exists between the two", entries.length > 0, entries.length);
  const gen2gen = entries.find(e => e.genIdA && e.genIdB &&
    (odyssey.generations || []).concat(mdx.generations || []).includes(e.genIdA) &&
    (odyssey.generations || []).concat(mdx.generations || []).includes(e.genIdB));
  check("...pinned to a specific generation on BOTH sides, not nameplate-to-nameplate",
    !!gen2gen, JSON.stringify(entries.map(e => ({ a: e.genIdA, b: e.genIdB, lvl: e.status }))));

  console.log("\nLLM calls made, in order:");
  llmCalls.forEach(c => console.log("   -", c.purpose));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
