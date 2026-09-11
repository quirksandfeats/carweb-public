// Real bug report: a scan of the Opel Astra returned all six generations
// correctly -- Astra F, G, H, J, K, L, with years and designers -- and every
// one was dropped, leaving "local LLM found no multiple generations here".
//
// The model wrote each code as the generation letter joined to a platform code
// ("Astra F / T91"). The letter half is in the article; the platform half
// isn't. The guard required every part of a composite to be verbatim, so one
// unverifiable half discarded a fully verified generation.
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "app", "llm_families.js"), "utf-8");
function slice(name) {
  const start = src.indexOf("\n  function " + name + "(");
  const after = src.indexOf("\n  function ", start + 10);
  const f = src.slice(start + 1, after);
  const lb = f.lastIndexOf("\n  }");
  return lb < 0 ? f : f.slice(0, lb + 4);
}
eval(src.match(/const GENERIC_CODE_PAREN_RE = [^\n]+/)[0] + "\n" +
     slice("codeAnchorIn") + "\n" + slice("splitCompositeCode") + "\n" + slice("codeVerifiedIn"));

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

// An Astra-shaped article: generation letters present, platform codes absent.
const hay = ("The Opel Astra F replaced the Kadett in 1991. The Astra G followed in 1998, " +
  "the Astra H in 2004, the Astra J in 2009, the Astra K in 2015 and the Astra L in 2021. " +
  "Hans Seer led the design.").toLowerCase();

for (const [code, want] of [
  ["Astra F / T91", "Astra F"], ["Astra G / T98", "Astra G"], ["Astra H / A04", "Astra H"],
  ["Astra J / P09", "Astra J"], ["Astra K / B15", "Astra K"], ["Astra L / C02", "Astra L"],
]) {
  t("kept: " + code, codeAnchorIn(hay, code) >= 0, codeAnchorIn(hay, code));
  t("  ...stored as just the verified half", codeVerifiedIn(hay, code) === want, codeVerifiedIn(hay, code));
}

// the guard still has to hold
t("a wholly invented composite is still dropped", codeAnchorIn(hay, "XYZ99 / QQQ1") === -1);
t("a wholly invented single code is still dropped", codeAnchorIn(hay, "FAKEXYZ") === -1);
t("a plain code that IS in the article passes unchanged",
  codeAnchorIn(hay, "Astra H") >= 0 && codeVerifiedIn(hay, "Astra H") === "Astra H");
t("a fully-verifiable composite keeps both halves",
  codeVerifiedIn(hay, "Astra F / Astra G") === "Astra F / Astra G",
  codeVerifiedIn(hay, "Astra F / Astra G"));
t("the invented half never reaches the stored code",
  !/T91|A04|C02/i.test(["Astra F / T91", "Astra H / A04", "Astra L / C02"]
    .map(c => codeVerifiedIn(hay, c)).join(" ")));


// Real bug report: adding the Fiat Topolino produced two good generations --
// "Fiat Topolino (1936–1955)" and "Fiat Topolino (2023)" -- and both were
// dropped, so the app said "no multiple generations here" while showing two in
// its own output. The parenthetical was a year range, which the model derives
// from the yearStart/yearEnd it reports separately; demanding it ALSO appear
// verbatim fails on the dash character alone.
{
  const topo = ("The Fiat Topolino was produced from 1936 until 1955. " +
    "In 2023 Fiat revived the name for a quadricycle based on the Citroen Ami.").toLowerCase();
  t("a year-range code is kept", codeAnchorIn(topo, "Fiat Topolino (1936–1955)") >= 0,
    codeAnchorIn(topo, "Fiat Topolino (1936–1955)"));
  t("a single-year code is kept", codeAnchorIn(topo, "Fiat Topolino (2023)") >= 0);
  t("an open-ended range is kept", codeAnchorIn(topo, "Fiat Topolino (2023–present)") >= 0);
  t("every dash character works",
    ["1936-1955", "1936–1955", "1936—1955"].every(r => codeAnchorIn(topo, "Fiat Topolino (" + r + ")") >= 0));
  // still a guard: a non-year parenthetical that isn't in the text is rejected
  t("a made-up descriptive parenthetical is still rejected",
    codeAnchorIn(topo, "Fiat Topolino (Sport Edition)") < 0);
  t("...and a car that isn't in the article at all is still rejected",
    codeAnchorIn(topo, "Fiat Nonesuch (1936–1955)") < 0);
}

// Real bug report: "the year dates were still listed as null. It seems to be
// the case for many new cars added to the knowledge graph." A lookup that came
// back empty was stored exactly like a successful one, and any stored record
// blocked all future attempts -- so one failure made the gap permanent.
{
  const useful = eval(slice("factsRecordIsUseful") + "\nfactsRecordIsUseful");
  t("a record that found a year counts as an answer", useful({ year: 1936 }));
  t("a record that found an end year counts", useful({ year: null, end: 1955 }));
  t("a person record with a birth year counts", useful({ born: 1963, died: null, country: null }));
  t("an all-null car record is a failed lookup, not an answer",
    !useful({ year: null, end: null }));
  t("an all-null person record likewise",
    !useful({ born: null, died: null, country: null }));
  t("nothing at all is not an answer", !useful(null));

  const src2 = fs.readFileSync(path.resolve(__dirname, "..", "..", "app", "llm_families.js"), "utf-8");
  t("only a useful record blocks a retry",
    /if \(prior && factsRecordIsUseful\(prior\)\) return;/.test(src2));
  t("...and retries are capped so a genuinely unknown year isn't asked forever",
    /if \(prior && \(prior\.tries \|\| 1\) >= 3\) return;/.test(src2));
}
console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
