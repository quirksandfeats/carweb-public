// Two real bug reports, verified against the user's own actual Playground
// output for Mercedes-Benz CLA <-> B-Class:
//
// 1. "matched from an explicit chassis/generation code..." should not still
//    require a Yes/No click -- if the deterministic evidence path already
//    found the code directly in an article's own text, that's trustworthy
//    enough to apply immediately (same trust level resolvePlatformMention's
//    exact-match tier already gets), with manual deletion later as the
//    escape hatch. Covers both the pure resolution logic (computeRelationEntry
//    / previewRelationResult) and the live app.js UI path (no Yes/No box
//    ever rendered, the real link is wired in with zero clicks).
//
// 2. The CLA's own article explicitly says it's "based on the platform of
//    ... Mercedes-Benz B-Class#Second generation (W246; 2011) compact
//    cars" -- but this kept resolving to nothing. Root cause, confirmed
//    from the user's own pasted Playground output: (a) the code's own
//    parenthetical has a semicolon INSIDE it separating the code from a
//    start year ("W246; 2011"), which tripped the old naive
//    stop-at-next-comma-or-semicolon window logic before it ever reached
//    the closing paren; (b) even with the window intact, that particular
//    generation's own `code` field is "B-Class (W246)" -- inconsistently
//    formatted from its siblings ("B W245"/"B W247") -- so a bare "W246"
//    extracted from the text never matched it under the existing exact/
//    prefix/suffix comparison tiers.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

function freshBareWindow(fetchImpl) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.fetch = fetchImpl;
  global.window = window; global.document = window.document;
  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  window.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return window;
}
function genInfo(id, make, label, wp, generations) { return { id, make, label, wp, generations }; }

// The exact real-shape text from the user's own bug report (paraphrased
// nameplate names to keep this self-contained/synthetic, identical
// structure and punctuation otherwise).
const CLA_WIKITEXT = "{{Infobox automobile\n| name = TestMercedes CLA\n}}\n" +
  "The TestMercedes CLA is based on the platform of the W176 TestMercedes A-Class and TestMercedes B-Class#Second generation (W246; 2011) compact cars.";
const B_WIKITEXT = "{{Infobox automobile\n| name = TestMercedes B\n}}\nA subcompact executive MPV.";

(async () => {
  console.log("--- pure resolution logic: paren-nested code extraction + auto-confirm ---");
  {
    const window = freshBareWindow((url) => {
      const u = String(url);
      const wt = u.includes("CLA") ? CLA_WIKITEXT : B_WIKITEXT;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-ac-cla", "TestMercedes", "CLA", "TestMercedes CLA", [
      { id: "m-test-ac-cla-c117", code: "CLA C117", year: 2013, end: 2019 },
      { id: "m-test-ac-cla-c118", code: "CLA C118", year: 2019, end: 2025 },
      { id: "m-test-ac-cla-c178", code: "CLA C178/174", year: 2025, end: null },
    ]);
    // Deliberately mirrors the real, inconsistent data shape: two
    // generations follow the "<label> <code>" convention, the middle one
    // kept its own original "<Nameplate> (<code>)" title verbatim.
    const infoB = genInfo("fam-test-ac-b", "TestMercedes", "B", "TestMercedes B", [
      { id: "m-test-ac-b-w245", code: "B W245", year: 2005, end: 2011 },
      { id: "m-test-ac-b-w246", code: "B-Class (W246)", year: 2011, end: 2018 },
      { id: "m-test-ac-b-w247", code: "B W247", year: 2018, end: 2026 },
    ]);
    // Same shape as the real report: the LLM confidently named a CLA
    // generation but came up empty on the B-Class side.
    const raw = { resolved: true, codeA: "CLA C178/174", codeB: null,
      reason: "The note explicitly states that the CLA is based on the platform of the W246 B-Class compact cars, but does not specify a particular generation." };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("evidence extraction survived the semicolon INSIDE the code's own parens", entry.debug.evidenceCodeForB === "W246", entry.debug.evidenceCodeForB);
    check("resolved to a real generation pair", entry.status === "confirmed" || entry.status === "provisional", entry.status);
    check("pinned the specific W246 generation despite its inconsistent 'B-Class (W246)' code format", entry.genIdB === "m-test-ac-b-w246", entry.genIdB);
    check("pinned the CLA generation the LLM named", entry.genIdA === "m-test-ac-cla-c178", entry.genIdA);
    check("matchLevel is a real generation<->generation pair", entry.matchLevel === "generation", entry.matchLevel);
    check("AUTO-CONFIRMED outright -- status is 'confirmed', not waiting on a Yes/No click", entry.status === "confirmed", entry.status);
    check("decidedAt is set, same as a real Yes click would set", !!entry.decidedAt);
    check("autoConfirmed flag set for anyone inspecting the entry later", entry.autoConfirmed === true);
  }

  console.log("--- pure resolution logic: LLM-only guess (no evidence) still requires review ---");
  {
    const A_WIKITEXT = "{{Infobox automobile\n| name = TestAlpha Ish\n}}\nA sedan.";
    const B_WIKITEXT2 = "{{Infobox automobile\n| name = TestBeta Ish\n}}\nA hatchback.";
    const window = freshBareWindow((url) => {
      const u = String(url);
      const wt = u.includes("Alpha") ? A_WIKITEXT : B_WIKITEXT2;
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
    });
    const infoA = genInfo("fam-test-ac-alpha", "TestMk", "TestAlpha Ish", "TestAlpha Ish",
      [{ id: "m-test-ac-alpha-1", code: "Alpha I", year: 2000, end: 2008 }, { id: "m-test-ac-alpha-2", code: "Alpha II", year: 2008, end: null }]);
    const infoB = genInfo("m-test-ac-beta", "TestMk", "TestBeta Ish", "TestBeta Ish",
      [{ id: "m-test-ac-beta", code: "TestBeta Ish", year: 2007, end: 2012 }]);
    const raw = { resolved: true, codeA: "Alpha II", codeB: "TestBeta Ish", reason: "The Beta Ish's own article explicitly states it's based on the Alpha Ish II." };
    const entry = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("an LLM-only resolution (no deterministic evidence) still lands on provisional, not auto-confirmed",
      entry.status === "provisional", entry.status);
    check("no autoConfirmed flag on a genuine review-worthy guess", !entry.autoConfirmed);
  }

  console.log("--- live app.js: evidence-resolved relation wires in with ZERO clicks ---");
  {
    function fakeCtx() {
      const noop = () => {};
      const h = { measureText: () => ({ width: 10 }) };
      return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
    }
    const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
    const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
    const { window } = dom;
    window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
    window.requestAnimationFrame = () => 1;
    window.devicePixelRatio = 1;
    window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
    Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

    const FAM_CLA = "fam-test-ac2-cla", C117 = "m-test-ac2-cla-c117", C118 = "m-test-ac2-cla-c118", C178 = "m-test-ac2-cla-c178";
    const FAM_B = "fam-test-ac2-b", W245 = "m-test-ac2-b-w245", W246 = "m-test-ac2-b-w246", W247 = "m-test-ac2-b-w247";

    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
        const wt = u.includes("CLA") ? CLA_WIKITEXT : B_WIKITEXT;
        return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": wt } } }) });
      }
      if (u === "/api/llm/chat") {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          resolved: true, codeA: "CLA C178/174", codeB: null,
          reason: "The note explicitly states the CLA shares a platform with the B-Class, but not a specific B-Class generation.",
        }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    };
    window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
    global.window = window; global.document = window.document;
    function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
    loadScript("d3.min.js");
    loadScript("data.js");
    const DATA = window.CARDATA;
    let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestMercedes");
    if (!mk) { mk = { id: "mk-test-ac2", type: "make", label: "TestMercedes", year: 1926 }; DATA.nodes.push(mk); }
    const famCla = { id: FAM_CLA, type: "family", label: "CLA", make: "TestMercedes", wp: "TestMercedes CLA", year: 2013, end: null, designers: [], engineers: [], generations: [C117, C118, C178] };
    const gc117 = { id: C117, type: "model", label: "CLA C117", make: "TestMercedes", year: 2013, end: 2019, familyOf: FAM_CLA };
    const gc118 = { id: C118, type: "model", label: "CLA C118", make: "TestMercedes", year: 2019, end: 2025, familyOf: FAM_CLA };
    const gc178 = { id: C178, type: "model", label: "CLA C178/174", make: "TestMercedes", year: 2025, end: null, familyOf: FAM_CLA };
    const famB = { id: FAM_B, type: "family", label: "B", make: "TestMercedes", wp: "TestMercedes B", year: 2005, end: null, designers: [], engineers: [], generations: [W245, W246, W247] };
    const gw245 = { id: W245, type: "model", label: "B W245", make: "TestMercedes", year: 2005, end: 2011, familyOf: FAM_B };
    const gw246 = { id: W246, type: "model", label: "B-Class (W246)", make: "TestMercedes", year: 2011, end: 2018, familyOf: FAM_B };
    const gw247 = { id: W247, type: "model", label: "B W247", make: "TestMercedes", year: 2018, end: 2026, familyOf: FAM_B };
    DATA.nodes.push(famCla, gc117, gc118, gc178, famB, gw245, gw246, gw247);
    DATA.links.push({ source: FAM_CLA, target: mk.id, type: "made" }, { source: FAM_B, target: mk.id, type: "made" });
    DATA.links.push({ source: FAM_CLA, target: C117, type: "generation" }, { source: FAM_CLA, target: C118, type: "generation" }, { source: FAM_CLA, target: C178, type: "generation" });
    DATA.links.push({ source: C117, target: C118, type: "gensucc" }, { source: C118, target: C178, type: "gensucc" });
    DATA.links.push({ source: FAM_B, target: W245, type: "generation" }, { source: FAM_B, target: W246, type: "generation" }, { source: FAM_B, target: W247, type: "generation" });
    DATA.links.push({ source: W245, target: W246, type: "gensucc" }, { source: W246, target: W247, type: "gensucc" });
    // The coarse, build-time-harvested "platform" link -- no note attached,
    // exactly the real-world shape.
    DATA.links.push({ source: FAM_CLA, target: FAM_B, type: "platform" });

    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
    loadScript("llm_families.js");
    loadScript("app.js");
    loadScript("timeline.js");
    loadScript("sixdeg.js");

    window.CarWeb.boot();
    const cw = window.CarWeb;
    cw.setYearRange(1900, cw.yearRange().max);
    cw.setLlmCheck(true);
    cw.openDetail(famCla);

    await new Promise(r => setTimeout(r, 60));

    const yesBtn = window.document.querySelector(".dt-relations .llm-rel-yes");
    check("NO Yes/No box was ever shown for an evidence-backed match -- it applied itself", !yesBtn);
    const resolvedBanner = window.document.querySelector(".dt-relations .llm-resolved");
    check("a resolved confirmation banner is shown immediately, with no click", !!resolvedBanner, resolvedBanner && resolvedBanner.textContent);

    const resolvedLink = cw.links.find(l => l.type === "platform" && l.llmResolved &&
      ((l.sn === gc178 && l.tn === gw246) || (l.sn === gw246 && l.tn === gc178)));
    check("the real CLA C178/174 <-> B-Class (W246) link was created with zero clicks", !!resolvedLink);

    const key = [FAM_CLA, FAM_B].sort().join("|") + "|platform";
    const relEntry = window.LlmFamilies.relationEntryFor(key);
    check("persisted entry is status 'confirmed'", relEntry && relEntry.status === "confirmed", relEntry && relEntry.status);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
