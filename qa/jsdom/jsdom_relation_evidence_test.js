// Real bug report: checking a "related" connection between two nameplates
// via the interactive detail-panel flow (unresolvedFamilyRelations ->
// checkRelation) always reported "couldn't confidently match a specific
// generation pair" for Mercedes-Benz A-Class <-> Infiniti Q30, even though
// the Infiniti article's own infobox states outright "Related: Infiniti
// Q30, Mercedes-Benz A-Class (W176), Mercedes-Benz GLA (X156)". Root cause:
// unlike the automatic generation-check flow (resolvePlatformMention),
// checkRelation never actually fetched or read either nameplate's own
// Wikipedia article -- it only ever had whatever (frequently null) `note`
// text the caller already happened to have, e.g. a build-time-harvested
// "related" link that never carried a note at all. This verifies
// llm_families.js's checkRelation now fetches both sides' own digest and
// resolves from an explicit article-stated code even when the LLM itself
// is (wrongly) not confident.
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

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

// ---------- ids ----------
const FAM_ID = "fam-test-relev-aclass", G1_ID = "m-test-relev-aclass-v1", G2_ID = "m-test-relev-aclass-v2";
const Q_ID = "m-test-relev-q30";

// Only the Q-side article actually documents the relationship, exactly like
// the real Infiniti Q30 article -- the A-Class-side article says nothing
// about Q30 at all, proving the fix works from EITHER direction, not just
// the side that happens to get opened first.
const Q_WIKITEXT = "{{Infobox automobile\n| name = TestInfiniti Q30ish\n| related = TestMercedes A-Classish3 (V1), TestMercedes GLA-ish (X1)\n}}\n" +
  "The TestInfiniti Q30ish shares its platform with the TestMercedes A-Classish3 (V1).";
const ACLASS_WIKITEXT = "{{Infobox automobile\n| name = TestMercedes A-Classish3\n}}\nA compact car nameplate with two generations.";

let lastOllamaBody = null;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    const wt = u.includes("Q30ish") ? Q_WIKITEXT : ACLASS_WIKITEXT;
    return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    lastOllamaBody = body;
    // Deliberately a firm non-match -- proves the deterministic
    // article-evidence path resolves this on its own, without needing (or
    // trusting) the small local model's own verdict.
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        resolved: false, codeA: null, codeB: null, reason: "no explicit generation named, only bare code lists to go on",
      }) } }] }),
    });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMk-relev");
if (!makeNode) { makeNode = { id: "mk-test-relev", type: "make", label: "TestMk-relev", year: 1950 }; DATA.nodes.push(makeNode); }
let infMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestInfiniti-relev");
if (!infMake) { infMake = { id: "mk-test-relev-inf", type: "make", label: "TestInfiniti-relev", year: 1950 }; DATA.nodes.push(infMake); }

const fam = { id: FAM_ID, type: "family", label: "A-Classish3", make: "TestMercedes", wp: "TestMercedes A-Classish3", year: 2012, end: null, designers: [], engineers: [], generations: [G1_ID, G2_ID] };
const g1 = { id: G1_ID, type: "model", label: "A-Classish3 V1", make: "TestMercedes", year: 2012, end: 2018, familyOf: FAM_ID };
const g2 = { id: G2_ID, type: "model", label: "A-Classish3 V2", make: "TestMercedes", year: 2018, end: null, familyOf: FAM_ID };
const modelQ = { id: Q_ID, type: "model", label: "Q30ish", make: "TestInfiniti-relev", wp: "TestInfiniti Q30ish", year: 2016, end: 2019 };
DATA.nodes.push(fam, g1, g2, modelQ);
DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" }, { source: Q_ID, target: infMake.id, type: "made" });
DATA.links.push({ source: FAM_ID, target: G1_ID, type: "generation" }, { source: FAM_ID, target: G2_ID, type: "generation" }, { source: G1_ID, target: G2_ID, type: "gensucc" });
// The build-time-harvested coarse "related" link, carrying NO note at all --
// exactly the real-world shape that produced the "couldn't confidently
// match" bug report.
DATA.links.push({ source: FAM_ID, target: Q_ID, type: "related" });

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
cw.setLlmCheck(true);

cw.openDetail(fam);

setTimeout(() => {
  const key = [FAM_ID, Q_ID].sort().join("|") + "|related";
  const entry = window.LlmFamilies.relationEntryFor(key);
  check("relation entry was persisted", !!entry);
  check("the outgoing note passed to the LLM included the Q30 article's own related-field text (not left empty)",
    !!lastOllamaBody && JSON.stringify(lastOllamaBody.messages).includes("A-Classish3 (V1)"));
  // Real user request: a match this well-grounded (an explicit code found
  // directly in the article text) shouldn't need a Yes/No click at all --
  // it auto-confirms straight away, same trust level resolvePlatformMention's
  // own exact-match tier already gets, with manual deletion later as the
  // escape hatch if it's ever wrong.
  check("AUTO-CONFIRMED outright, even though the LLM itself said resolved:false", entry && entry.status === "confirmed", entry && entry.status);
  check("matched down to the SPECIFIC generation (V1) named in the Q30 article, not left at the nameplate level",
    entry && entry.genIdA === G1_ID, entry && entry.genIdA);
  check("matchLevel is 'generation' (both sides pinned down -- Q30 has only one generation of its own)",
    entry && entry.matchLevel === "generation", entry && entry.matchLevel);
  check("reason credits the article evidence, not a guess", entry && /explicit/i.test(entry.reason || ""), entry && entry.reason);
  check("debug shows both articles were actually fetched", entry && entry.debug && entry.debug.fetchedArticleA && entry.debug.fetchedArticleB);

  const yesBtn = window.document.querySelector(".dt-relations .llm-rel-yes");
  check("NO Yes/No box shown -- an evidence-backed match applies itself with zero clicks", !yesBtn);
  const resolvedBanner = window.document.querySelector(".dt-relations .llm-resolved");
  check("a resolved confirmation banner is shown immediately instead", !!resolvedBanner, resolvedBanner && resolvedBanner.textContent);
  const resolvedLink = cw.links.find(l => l.type === "related" && l.llmResolved &&
    ((l.sn === g1 && l.tn === modelQ) || (l.sn === modelQ && l.tn === g1)));
  check("genuine A-Classish3(V1) <-> Q30ish link created with zero clicks", !!resolvedLink);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}, 50);
