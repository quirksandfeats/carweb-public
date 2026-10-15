// A re-read that only names a generation differently is not a change. On
// 14 Oct 2026, 261 nameplate re-checks were waiting for review, and most of
// them proposed retiring generations the re-read had merely relabelled:
// "QX50 (J50)" read back as "First generation (J50)", every "Civic (eighth
// generation)" as "Eighth generation (2005)", the bare "Boxster and Cayman"
// (1996-2005) as "986" (1996-2004). Each retirement took the generation's
// relationships with it. pairFreshGenerations now pairs these, but only where
// exactly one match exists both ways, and never across two different codes.
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

const pairs = (old, fresh) => LF.pairFreshGenerations(old, fresh).map(o => o ? o.id : null);
const gen = (id, label, year, end) => ({ id, label, year, end });
const f = (code, yearStart, yearEnd) => ({ code, yearStart, yearEnd });

t("a code in brackets pairs: \"First generation (J50)\" is \"QX50 (J50)\"",
  JSON.stringify(pairs([gen("j50", "QX50 (J50)", 2007, 2017), gen("j55", "QX50 (J55)", 2017, null)],
                       [f("First generation (J50)", 2007, 2017), f("Second generation (J55)", 2017, null)])) === '["j50","j55"]');

const civic = [gen("c7", "Civic (seventh generation)", 2000, 2005), gen("c8", "Civic (eighth generation)", 2005, 2012),
               gen("c9", "Civic (ninth generation)", 2011, 2017)];
t("the same place in the line pairs: \"Eighth generation (2005)\" is \"Civic (eighth generation)\"",
  JSON.stringify(pairs(civic, [f("Seventh generation (2000)", 2000, 2005), f("Eighth generation (2005)", 2005, 2012),
                               f("Ninth generation (2011)", 2011, 2017)])) === '["c7","c8","c9"]');
t("...but not where the years say otherwise (the Mondeo \"Mk3\" is its second generation)",
  pairs([gen("m3", "Mondeo (third generation)", 2007, 2014)], [f("Mk3", 2000, 2007)])[0] === null);

t("the bare nameplate pairs with the one generation whose years it has",
  pairs([gen("bare", "Boxster and Cayman", 1996, 2005), gen("987", "Boxster and Cayman (987)", 2005, 2012)],
        [f("986", 1996, 2004), f("987", 2005, 2012), f("982", 2016, 2025)]).join() === "bare,987,");
t("two entries with the same years pair with nothing",
  pairs([gen("a", "Accord", 1990, 1994)], [f("North America", 1990, 1994), f("Europe", 1990, 1994)]).join() === ",");
t("the same years under two different codes are two cars (Citroën C3 CC24 and CC21)",
  pairs([gen("cc24", "C3 CC24", 2024, null), gen("c2", "C3 (C2)", 2016, 2024)], [f("CC21 (Europe)", 2024, null)])[0] === null);
t("\"E9x\" is the family of \"E90\"",
  pairs([gen("e90", "B3 (E90)", 2007, 2013), gen("e46", "B3 (E46)", 1999, 2006)], [f("E9x", 2007, 2012)])[0] === "e90");
t("an exact code still wins over a looser match",
  pairs([gen("x", "Golf Mk4", 1997, 2003), gen("y", "Golf (fourth generation)", 1997, 2003)], [f("Mk4", 1997, 2003)])[0] === "x");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
