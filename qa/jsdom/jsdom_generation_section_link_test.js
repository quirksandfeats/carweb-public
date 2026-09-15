// Real user request: "not all the info about each generation exists within
// this page, but there are links in each of the sections where the
// generations are given a summary. Those links are where the actual
// information exists about that given generation... there are many links on
// this page, and the only actual relevant ones are the ones that come right
// after the description of a particular generation, so context matters in
// which link is followed."
//
// Checked against real article wikitext, not a fixture shaped to pass. Two
// shapes exist and they need opposite treatment:
//
//   Volkswagen Golf -- an umbrella nameplate whose every generation heading
//     is followed immediately by {{Main article|Volkswagen Golf Mk4}}. The
//     link is stated, so nothing has to be guessed -- and title-guessing
//     could never have found it, because the article is "Volkswagen Golf
//     Mk4" and every shape the guesser tries looks like "Volkswagen Golf
//     (Mk4)".
//
//   Mercedes-Benz E-Class -- no hatnotes at all; the per-generation article
//     is linked from prose, surrounded by links to 4Matic, catalytic
//     converters and Motor Trend awards. Here the guesser is the one that
//     works, because those articles ARE named "Mercedes-Benz E-Class (W213)".
//
// So this pins down: the stated link wins where there is one, an unrelated
// link is never followed, and neither path is allowed to return something
// that is really the nameplate's own article again.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.resolve(__dirname, "..", "..", "app");
const CACHE = path.resolve(__dirname, "..", "wiki_cache");
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

const GOLF = fs.readFileSync(path.join(CACHE, "Volkswagen_Golf.wikitext"), "utf-8");
const GCLASS = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_G-Class.wikitext"), "utf-8");

// The E-Class shape, written out as wikitext because the cache has no
// hatnote-free umbrella in it: generation headings, prose links to the real
// article, and plenty of links that are not it.
const ECLASS = [
  "{{Infobox automobile\n| name = Mercedes-Benz E-Class\n}}",
  "The E-Class is an executive car.",
  "==W212 (2009)==",
  "The W212 replaced the [[Mercedes-Benz E-Class (W211)|W211]] in 2009. It offered [[4Matic]] " +
    "all-wheel drive and won a [[Motor Trend]] award. See [[Mercedes-Benz E-Class (W212)]] for detail.",
  "==W213 (2016)==",
  "The fifth generation was unveiled at the [[North American International Auto Show]]. " +
    "It borrowed styling from the [[Mercedes-Benz S-Class]] and used a [[catalytic converter]]. " +
    "Full coverage is at [[Mercedes-Benz E-Class (W213)]].",
].join("\n\n");

// One window, purely to get at llm_families.js's exports.
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };

// Every article this test needs, served from the cache instead of the network.
const ARTICLES = {
  "Volkswagen Golf": GOLF,
  "Volkswagen Golf Mk4": "{{Infobox automobile}}\n== Overview ==\nThe Mk4 Golf.",
  "Mercedes-Benz E-Class": ECLASS,
  "Mercedes-Benz E-Class (W213)": "{{Infobox automobile}}\n== Overview ==\nThe W213.",
  "Mercedes-Benz E-Class (W211)": "{{Infobox automobile}}\n== Overview ==\nThe W211.",
  "Mercedes-Benz E-Class (W212)": "{{Infobox automobile}}\n== Overview ==\nThe W212.",
};
const asked = [];
window.fetch = (url) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    asked.push(title);
    const wt = ARTICLES[title];
    if (!wt) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
ev("llm_families.js");
const LF = window.LlmFamilies;

// ---------- 1. the sections themselves, on a real article ----------
{
  const secs = LF.wikitextSections(GOLF);
  check("the real Golf article splits into sections", secs.length >= 19, secs.length);
  const mk4 = secs.find(s => /Fourth generation/.test(s.title));
  check("a generation heading survives its anchor spans and italics",
        !!mk4 && /^Fourth generation \(Mk4\/A4, Typ 1J; 1997\)$/.test(mk4.title), mk4 && mk4.title);
  check("...and its body stops before the next generation",
        !!mk4 && !/Fifth generation/.test(mk4.body));
  check("...but keeps its own sub-sections",
        !!mk4 && /Extended production/.test(mk4.body));
}

// ---------- 2. the stated link ----------
{
  const sec = LF.sectionForCode(GOLF, "Mk4");
  check("the Mk4 section is found by its code", !!sec, sec && sec.title);
  check("...and the more specific 'Mk4.5' sub-heading does not win it",
        !!sec && /Fourth generation/.test(sec.title), sec && sec.title);
  check("the hatnote names the article outright",
        LF.hatnoteArticle(sec.body) === "Volkswagen Golf Mk4", LF.hatnoteArticle(sec.body));

  const mk8 = LF.sectionForCode(GOLF, "CD1");
  check("{{Main}} works as well as {{Main article}}",
        mk8 && LF.hatnoteArticle(mk8.body) === "Volkswagen Golf Mk8", mk8 && LF.hatnoteArticle(mk8.body));

  // The Golf's own "Electric versions" section opens with {{See also|...}},
  // which is not a statement that the section IS that article.
  const ev2 = LF.wikitextSections(GOLF).find(s => /Electric versions/.test(s.title));
  check("a {{See also}} is not mistaken for the generation's article",
        !!ev2 && LF.hatnoteArticle(ev2.body) === null, ev2 && LF.hatnoteArticle(ev2.body));
}

// ---------- 3. prose, with the distractors the user warned about ----------
{
  const sec = LF.sectionForCode(ECLASS, "W213");
  check("the W213 section is found", !!sec, sec && sec.title);
  check("no hatnote here, which is the whole difficulty",
        LF.hatnoteArticle(sec.body) === null);
  check("the prose link picked is the generation's own article",
        LF.proseArticle(sec.body, "Mercedes-Benz", "W213") === "Mercedes-Benz E-Class (W213)",
        LF.proseArticle(sec.body, "Mercedes-Benz", "W213"));
  check("...not the S-Class, the auto show or the catalytic converter",
        !/S-Class|Auto Show|catalytic/.test(LF.proseArticle(sec.body, "Mercedes-Benz", "W213") || ""));

  // Context matters: the W211 link lives in the W212's section, and asking
  // for W212 must not follow it.
  const s212 = LF.sectionForCode(ECLASS, "W212");
  check("a link to a DIFFERENT generation in the same section is not followed",
        LF.proseArticle(s212.body, "Mercedes-Benz", "W212") === "Mercedes-Benz E-Class (W212)",
        LF.proseArticle(s212.body, "Mercedes-Benz", "W212"));

  check("a code with no link anywhere yields nothing rather than a guess",
        LF.proseArticle(sec.body, "Mercedes-Benz", "W999") === null);
  check("a same-code car from another marque is refused",
        LF.proseArticle(sec.body, "BMW", "W213") === null);
}

// ---------- 4. end to end, through the real lookup ----------
(async () => {
  asked.length = 0;
  const golfMk4 = { label: "Golf Mk4", make: "Volkswagen", wp: "Volkswagen Golf" };
  const got = await LF.findGenerationArticle(golfMk4, "Golf", "Volkswagen Golf", "Volkswagen Golf");
  check("the Golf's Mk4 resolves to the article the section states",
        got === "Volkswagen Golf Mk4", got);
  check("...and it was found without brute-forcing title shapes first",
        asked.indexOf("Volkswagen Golf Mk4") < (asked.indexOf("Volkswagen Golf (Mk4)") + 1 || 99),
        asked.join(" | ").slice(0, 120));

  const w213 = { label: "E-Class (W213)", make: "Mercedes-Benz", wp: "Mercedes-Benz E-Class" };
  const got2 = await LF.findGenerationArticle(w213, "E-Class", "Mercedes-Benz E-Class", "Mercedes-Benz E-Class");
  check("the hatnote-free E-Class still resolves its generation",
        got2 === "Mercedes-Benz E-Class (W213)", got2);

  // The nameplate's own article is never an "upgrade" on itself.
  const bogus = { label: "G-Class (W999)", make: "Mercedes-Benz", wp: "Mercedes-Benz G-Class" };
  const got3 = await LF.findGenerationArticle(bogus, "G-Class", "Mercedes-Benz G-Class", "Mercedes-Benz G-Class");
  check("a generation with no article of its own returns nothing", got3 === null, got3);

  // A single-article nameplate: the G-Class keeps every generation on one
  // page, so there is nothing to follow and nothing should be invented.
  const w460 = { label: "G-Class (W460)", make: "Mercedes-Benz", wp: "Mercedes-Benz G-Class" };
  const sec460 = LF.sectionForCode(GCLASS, "W460");
  check("the G-Class's own W460 section is found", !!sec460, sec460 && sec460.title);
  check("...and states no article, because there isn't one",
        LF.hatnoteArticle(sec460.body) === null, LF.hatnoteArticle(sec460.body));
  const got4 = await LF.findGenerationArticle(w460, "G-Class", "Mercedes-Benz G-Class", "Mercedes-Benz G-Class");
  check("...so the lookup declines rather than following {{Main|Peugeot P4}} "
        + "from a sub-section about a derivative", got4 === null, got4);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
