// Real user request: "I think it would be useful that for a nameplate, there
// is a lighter llm recheck button and a more extensive one, which includes
// reading through the generations' own articles again."
//
// Behind it: 🔄 LLM Re-check re-reads the NAMEPLATE's article and nothing
// else. Generation research -- the pass that reads a generation's OWN article
// (the W211 page rather than the general E-Class one), which is where the
// fuller designer/engineer/related-car lists live -- runs from a button on
// each generation's card, once, and stays "✓ Researched" forever. So a
// re-check could never pick up anything that is only stated there.
//
// The two buttons have to differ in exactly that, and the difference has to
// be visible in model calls, not just in wording: light = one call, deep =
// one call plus one per generation.
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

const FAM = "fam-testdeep-saloon", G1 = "m-testdeep-w1", G2 = "m-testdeep-w2";

// The umbrella page: sections that POINT at each generation's article and
// name nobody and nothing themselves. This is the real E-Class shape.
const UMBRELLA = `{{Infobox automobile
| name = TestDeep Saloon
| manufacturer = TestDeep
}}
The TestDeep Saloon is a car.

== First generation (W1; 1990) ==
{{main|TestDeep W1}}
The W1 was built from 1990 to 1999.

== Second generation (W2; 2000) ==
{{main|TestDeep W2}}
The W2 was built from 2000 to 2009.
`;
// The generation pages: where the credits and the engines actually are.
const W1 = `{{Infobox automobile
| name = TestDeep W1
| designer = Ada Frame
| engine = [[TestDeep M1 engine|M1 2.0 L I4]]
}}
The W1 shares its platform with the TestDeep Coupe.
`;
const W2 = `{{Infobox automobile
| name = TestDeep W2
| designer = Bo Panel
| engine = [[TestDeep M2 engine|M2 3.0 L V6]]
}}
The W2 shares its platform with the TestDeep Coupe.
`;
const ARTICLES = { "TestDeep Saloon": UMBRELLA, "TestDeep W1": W1, "TestDeep W2": W2 };

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

// Every model call records WHICH article's text it was given, so "did the
// deep pass really read the generation pages" is answered by what the model
// was shown, not by counting calls alone.
const llmCalls = [];
const articleReads = [];
window.fetch = (url, opts) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    articleReads.push(title);
    const wt = ARTICLES[title];
    if (!wt) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse((opts && opts.body) || "{}");
    const sent = JSON.stringify(body.messages || []);
    // Labelled by the purpose each call site states, not by scanning the
    // prompt. Scanning does not work here, and finding out why is half the
    // point of this test: the NAMEPLATE check already follows the section
    // hatnotes and inlines each generation's sub-article into its own
    // prompt (see llm_families.js's articleFromNameplateSection), so the
    // umbrella's prompt legitimately contains the W1 infobox too.
    const purpose = String(body.purpose || "");
    const about = /\(W1\)/.test(purpose) ? "W1" : /\(W2\)/.test(purpose) ? "W2"
                : /Saloon · split/.test(purpose) ? "umbrella" : "other";
    llmCalls.push(about);
    // Answer for whichever article it was actually given -- a stub that
    // answers the same thing regardless proves nothing about which page was
    // read (a mistake an earlier test in this suite really made).
    const gens = about === "other" ? []
      : about === "umbrella"
      ? [{ code: "W1", yearStart: 1990, yearEnd: 1999, designers: [], engineers: [], sharedPlatforms: [] },
         { code: "W2", yearStart: 2000, yearEnd: 2009, designers: [], engineers: [], sharedPlatforms: [] }]
      : about === "W1"
      ? [{ code: "W1", yearStart: 1990, yearEnd: 1999, designers: ["Ada Frame"], engineers: [], sharedPlatforms: [] }]
      : [{ code: "W2", yearStart: 2000, yearEnd: 2009, designers: ["Bo Panel"], engineers: [], sharedPlatforms: [] }];
    if (about === "other") {
      // A people-bio recall or similar incidental lookup -- not what this
      // test measures, and it must not be counted as a generation read.
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content:
      JSON.stringify({ hasMultipleGenerations: about === "umbrella", generations: gens }) } }] }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-testdeep", type: "make", label: "TestDeep", year: 1990 };
    const fam = { id: FAM, type: "family", label: "Saloon", make: "TestDeep", year: 1990,
                  wp: "TestDeep Saloon", generations: [G1, G2], designers: [], engineers: [] };
    D.nodes.push(mk, fam);
    D.links.push({ source: FAM, target: mk.id, type: "made" });
    // As applyFamilyOverride mints them: inheriting the NAMEPLATE's article.
    [[G1, "Saloon (W1)", 1990, 1999], [G2, "Saloon (W2)", 2000, 2009]].forEach(([id, label, y, e]) => {
      D.nodes.push({ id, type: "model", label, make: "TestDeep", familyOf: FAM, year: y, end: e,
                     wp: "TestDeep Saloon", designers: [], engineers: [] });
      D.links.push({ source: FAM, target: id, type: "generation" });
    });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;

(async () => {
  // ---------- 1. both buttons are offered ----------
  const fam = cw.byId.get(FAM);
  cw.openDetail(fam);
  const block = window.document.querySelector(".dt-llmcheck");
  check("the nameplate offers an ordinary re-check", !!block.querySelector(".llm-recheck-btn"));
  check("...and a deep one next to it", !!block.querySelector(".llm-deep-recheck-btn"));
  check("the deep button says what the extra cost is, in generations",
        /2 here/.test(block.querySelector(".llm-deep-recheck-btn").title),
        block.querySelector(".llm-deep-recheck-btn").title.slice(-60));

  // ---------- 2. the light one reads the nameplate, and stops ----------
  {
    llmCalls.length = 0; articleReads.length = 0;
    block.querySelector(".llm-recheck-btn").click();
    for (let i = 0; i < 60 && !LF.recheckEntryFor(FAM); i++) await sleep(20);
    await sleep(250);
    const gen1 = llmCalls.filter(c => c === "W1" || c === "W2");
    check("the light re-check asked the model about the nameplate, once",
          llmCalls.filter(c => c === "umbrella").length === 1, llmCalls.join(","));
    check("...and never asked it about a generation on its own", gen1.length === 0, llmCalls.join(","));
    check("...nor recorded any generation research",
          !LF.genResearchEntryFor(G1) && !LF.genResearchEntryFor(G2));
    // The light pass does upgrade the wp link -- the engine scan has to find
    // each generation's own article to read its infobox, and keeping what it
    // found is free. What it does NOT do is ask the model about that article.
    check("the generation's own article is still found and kept",
          cw.byId.get(G1).wp === "TestDeep W1", cw.byId.get(G1).wp);
    // Engines ARE still read here -- an infobox field is a regex, not a
    // model call, so the cheap half belongs in the light pass.
    check("it did read the generation pages for engines, without a model call",
          articleReads.includes("TestDeep W1") && gen1.length === 0,
          articleReads.join(" | "));
  }

  // ---------- 3. the deep one goes on to each generation's own article ----------
  {
    llmCalls.length = 0; articleReads.length = 0;
    const row = window.document.querySelector(".dt-llmcheck .llm-recheck-row");
    row.querySelector(".llm-deep-recheck-btn").click();
    for (let i = 0; i < 300 && !(LF.genResearchEntryFor(G1) && LF.genResearchEntryFor(G2)); i++) await sleep(20);
    await sleep(300);
    check("the deep re-check asked the model once per generation, plus the nameplate",
          llmCalls.filter(c => c === "umbrella").length === 1 &&
          llmCalls.filter(c => c === "W1" || c === "W2").length === 2, llmCalls.join(","));
    check("...one for each of them, not the same one twice",
          llmCalls.filter(c => c === "W1").length === 1 && llmCalls.filter(c => c === "W2").length === 1,
          llmCalls.join(","));
    check("both generations are now researched",
          LF.genResearchEntryFor(G1).status === "done" && LF.genResearchEntryFor(G2).status === "done",
          LF.genResearchEntryFor(G1).status + "/" + LF.genResearchEntryFor(G2).status);
    check("each generation now reads its own article, not the nameplate's",
          cw.byId.get(G1).wp === "TestDeep W1" && cw.byId.get(G2).wp === "TestDeep W2",
          cw.byId.get(G1).wp + " / " + cw.byId.get(G2).wp);
    check("the credit stated only on the W1's own page is picked up",
          (cw.byId.get(G1).designers || []).includes("Ada Frame"), cw.byId.get(G1).designers);
    check("...and the W2's, from its own page and not the W1's",
          (cw.byId.get(G2).designers || []).includes("Bo Panel") &&
          !(cw.byId.get(G2).designers || []).includes("Ada Frame"), cw.byId.get(G2).designers);
    check("the designer exists as a real node with a real link",
          window.CARDATA.nodes.some(n => n.type === "person" && n.label === "Ada Frame") &&
          window.CARDATA.links.some(l => l.type === "designed" &&
            (l.source.id || l.source) === G1));
    // The bug this found: forceRecheckFamily mints person nodes and links
    // straight into the live arrays and nothing indexed them, so the next
    // buildSim dropped the links as having no endpoint and
    // computeYearFilterSet threw on adj.get(id) for a node in `nodes` but in
    // no index.
    check("...and it is in the graph's indexes, not just the array",
          !!cw.byId.get("p-ada-frame") && !!cw.adj.get("p-ada-frame"),
          !!cw.byId.get("p-ada-frame"));
    const status = window.document.querySelector(".dt-llmcheck").textContent;
    check("the panel reports what the deep pass did", /Deep re-check complete/.test(status),
          status.trim().slice(0, 120));
    check("...and says it re-read both generation articles", /2 generation article/.test(status),
          status.trim().slice(0, 120));
    // It has to survive the renders that happen straight afterwards -- the
    // reason the summary is not written into the row itself.
    cw.openDetail(cw.byId.get(FAM));
    check("...and it is still there after the panel is reopened",
          /Deep re-check complete/.test(window.document.querySelector(".dt-llmcheck").textContent));
  }

  // ---------- 4. it is genuinely repeatable ----------
  {
    llmCalls.length = 0;
    cw.openDetail(cw.byId.get(FAM));
    const row = window.document.querySelector(".dt-llmcheck .llm-recheck-row");
    check("(precondition) the buttons come back on reopen", !!row.querySelector(".llm-deep-recheck-btn"));
    row.querySelector(".llm-deep-recheck-btn").click();
    for (let i = 0; i < 300 && llmCalls.filter(c => c === "W1" || c === "W2").length < 2; i++) await sleep(20);
    await sleep(200);
    check("a second deep re-check re-reads everything rather than short-circuiting",
          llmCalls.filter(c => c === "umbrella").length === 1 &&
          llmCalls.filter(c => c === "W1" || c === "W2").length === 2, llmCalls.join(","));
    check("...without duplicating the designer node",
          window.CARDATA.nodes.filter(n => n.label === "Ada Frame").length === 1,
          window.CARDATA.nodes.filter(n => n.label === "Ada Frame").length);
    check("...or the link", window.CARDATA.links.filter(l => l.type === "designed" &&
          (l.source.id || l.source) === G1).length === 1);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
