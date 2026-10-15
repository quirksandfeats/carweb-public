// Generations not built yet. Real user request (14 Oct 2026): "if there is a
// planned upcoming model in any case, add it but provide info that it's a
// future model in some way, regardless of whether or not it has a start year
// (although that would be preferred if it's able to be found)." The case on
// record: the Porsche Boxster and Cayman's "Fifth generation", whose section
// says it is "due to hit the market in 2026" and gives no years.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
const w = dom.window; global.window = w; global.document = w.document;
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
w.LLM_FAMILIES = { families: {}, __serverAvailable: false };
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;
const now = new Date().getFullYear();
const wikitext = `== <span class="anchor" id="982"></span>Fourth generation: 982 (2016–2025) ==
Built in Zuffenhausen.
== Fifth generation (${now + 1}) ==
Porsche has confirmed that the next-generation car, due to hit the market in ${now + 1}, will be electric.
== Sixth generation ==
Nothing is known.
== Motorsport ==
Raced widely.`;
const gens = [{ code: "982", yearStart: 2016, yearEnd: 2025 }, { code: "Fifth generation", yearStart: null },
              { code: "Sixth generation", yearStart: null }, { code: "EV", yearStart: now + 3 }];
LF.markFutureGenerations(gens, wikitext);
t("a generation already built is not future", !gens[0].future);
t("an undated one its own section calls due is future", gens[1].future === true);
t("...with the year the section expects it", gens[1].expectedYear === now + 1, gens[1].expectedYear);
t("an undated one its section says nothing about is not", !gens[2].future);
t("one whose start year is after this one is future, expected that year", gens[3].future && gens[3].expectedYear === now + 3);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
