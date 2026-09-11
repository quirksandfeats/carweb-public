// Real bug report, from Andy's Acura Legend / Honda Legend checks.
//
// Asked whether the mention "Daewoo Arcadia" -- named as a platform-mate on
// the Legend's 1990-1995 generation -- already existed in the graph, the local
// model answered m-daewoo-magnus with confidence "high" and this reasoning:
//
//   "Daewoo Arcadia is the export name for the Daewoo Magnus, sold in markets
//    like the Middle East and Southeast Asia, while the Magnus was sold in
//    Europe and other regions. They are the exact same vehicle (Opel Vectra C
//    platform)."
//
// Every claim in that is invented. The Arcadia is a licensed second-generation
// Honda Legend built 1994-1999; the Magnus is Daewoo's own V200, 2000-2006,
// with no Honda content at all. The only thing they share is the marque -- and
// sharing a marque is exactly why the Magnus was offered as a candidate, since
// buildDuplicateCandidates hands over every same-make car.
//
// The existing hallucination guard only asks "was that id one of the ones we
// offered", which it was. The property asserted here is the new one: an
// identity match claims two records are the SAME car, and the same car cannot
// have been built in two eras that don't touch.
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

// The real shape of the failure: same marque, totally different model name,
// production eras five years apart.
const MK = "mk-daewoo-t", MAGNUS = "m-daewoo-magnus-t", LEGANZA = "m-daewoo-leganza-t";
const ESPERO = "m-daewoo-espero-t";

function freshWindow(reply) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  window.fetch = (url, opts) => {
    if (String(url).includes("/api/llm")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  global.window = window;
  global.document = window.document;
  window.eval(fs.readFileSync(path.join(APP, "d3.min.js"), "utf-8"));
  window.eval(fs.readFileSync(path.join(APP, "data.js"), "utf-8"));
  window.CARDATA.nodes.push(
    { id: MK, type: "make", label: "DaewooT", year: 1980 },
    { id: MAGNUS, type: "model", label: "Magnus", make: "DaewooT", year: 2000, end: 2006 },
    { id: LEGANZA, type: "model", label: "Leganza", make: "DaewooT", year: 1997, end: 2002 },
    // Andy's correction, and the case the veto must never touch: "Production
    // doesn't necessarily have to overlap, since it might be that one car has
    // stopped production, but then a new car a few years later uses the same
    // platform as that previously discontinued car."
    { id: ESPERO, type: "model", label: "Espero 800-series", make: "DaewooT", year: 1986, end: 1999 },
  );
  window.LLM_FAMILIES = { families: {}, relations: {}, __serverAvailable: true };
  window.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return window;
}

(async () => {
  console.log("--- the exact Arcadia / Magnus claim ---");
  {
    const window = freshWindow({
      matchId: MAGNUS, confidence: "high",
      reason: "DaewooT Arcadia is the export name for the DaewooT Magnus. They are the exact same vehicle (Opel Vectra C platform).",
    });
    const LF = window.LlmFamilies;
    const nodes = window.CARDATA.nodes;
    // The mention was found on a 1990-1995 generation.
    const v = await LF.verifySharedPlatformMention(nodes, "DaewooT Arcadia", null, { start: 1990, end: 1995 });
    check("the confident wrong match is refused", !v || v.matchId === null, JSON.stringify(v));
    check("...and says which claim it disbelieved, and why",
      v && /doesn't overlap/.test(v.reason || "") && /Magnus/.test(v.reason || ""), v && v.reason);
    check("...and says plainly that platform reuse is a different claim",
      v && /reusing an older car's platform/.test(v.reason || ""));
    check("...keeping the model's own words for the debug view",
      v && /export name/.test(v.reason || ""));
    check("...and recording the id it turned down", v && v.rejectedMatchId === MAGNUS, v && v.rejectedMatchId);
  }

  console.log("\n--- it must not break a genuine rename ---");
  {
    // The Auris/Corolla case this sanity pass exists for: different names, same
    // era. Nothing about the names matches, and that is fine -- the years do.
    const window = freshWindow({
      matchId: LEGANZA, confidence: "high",
      reason: "Sold as the Leganza in export markets; same car, same V100 chassis.",
    });
    const LF = window.LlmFamilies;
    const v = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Nubira X", null, { start: 1997, end: 2002 });
    check("a same-era rename under a different name is still accepted",
      v && v.matchId === LEGANZA, JSON.stringify(v));
  }
  {
    // A clone typically starts a few years into the donor's run and can outlive
    // it -- the veto has to be generous enough not to reject that.
    const window = freshWindow({ matchId: LEGANZA, confidence: "high", reason: "Licensed clone." });
    const LF = window.LlmFamilies;
    const v = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Something", null, { start: 1994, end: 1999 });
    check("a partially-overlapping licensed clone is accepted", v && v.matchId === LEGANZA, JSON.stringify(v));
  }

  console.log("\n--- a later car reusing a discontinued car's platform ---");
  {
    // Andy's correction to a first, broader version of this guard. The mention
    // NAMES the older car, so which node it refers to is not in doubt; the eras
    // are 20 years apart and that is completely normal for platform reuse. The
    // year test must not fire here at all.
    const window = freshWindow({
      matchId: ESPERO, confidence: "high",
      reason: "The 800-series is the Espero 800-series already in the database.",
    });
    const LF = window.LlmFamilies;
    const v = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Espero 800-series", null, { start: 2005, end: 2012 });
    check("a 2005 car reusing a 1986-1999 car's platform still resolves to it",
      v && v.matchId === ESPERO, JSON.stringify(v));
  }
  {
    // Same thing with the mention worded slightly differently from the stored
    // label -- the loose-match case, which is exactly when this sanity pass runs.
    const window = freshWindow({ matchId: ESPERO, confidence: "high", reason: "Same car, different wording." });
    const LF = window.LlmFamilies;
    const v = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Espero (800 series)", null, { start: 2005, end: 2012 });
    check("...and so does a differently-worded mention of the same car",
      v && v.matchId === ESPERO, JSON.stringify(v));
  }
  {
    // A shared chassis code written two ways is still the same car.
    const window = freshWindow({ matchId: ESPERO, confidence: "high", reason: "KA7/8 is the KA7." });
    const LF = window.LlmFamilies;
    const v = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Espero 800", null, { start: 2010, end: null });
    check("...and a code written slightly differently on each side",
      v && v.matchId === ESPERO, JSON.stringify(v));
  }

  console.log("\n--- unknown years are never treated as evidence ---");
  {
    const window = freshWindow({ matchId: MAGNUS, confidence: "high", reason: "Same car." });
    const LF = window.LlmFamilies;
    const v = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Whatever", null, { start: null, end: null });
    check("no years on the mentioning generation means no veto", v && v.matchId === MAGNUS, JSON.stringify(v));
    const v2 = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Whatever2", null, undefined);
    check("no year info at all means no veto", v2 && v2.matchId === MAGNUS, JSON.stringify(v2));
  }

  console.log("\n--- a null answer is still a null answer ---");
  {
    const window = freshWindow({ matchId: null, confidence: "high", reason: "None of these." });
    const LF = window.LlmFamilies;
    const v = await LF.verifySharedPlatformMention(window.CARDATA.nodes, "DaewooT Arcadia", null, { start: 1990, end: 1995 });
    check("passes through untouched", v && v.matchId === null, JSON.stringify(v));
  }

  console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
