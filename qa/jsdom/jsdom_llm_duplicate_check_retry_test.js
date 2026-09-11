// Real bug report: a round-robined Ollama pool member can be transiently
// unreachable (still starting up, or briefly overloaded from several
// checks landing on it at once) even though the pool as a whole is
// healthy -- serve.py's 502 "could not reach Ollama" surfaces this as a
// failed fetch. verifySharedPlatformMention (llm_families.js) now retries
// the duplicate-check call once after a short pause before giving up and
// falling back to the deterministic-only path. This test proves: (1) a
// mention that fails once then succeeds on retry still resolves correctly
// onto the real existing node (the transient failure is invisible to the
// end result), and (2) a mention that fails BOTH times degrades gracefully
// -- no sanity-check verdict, no crash/hang -- and never lets a failed
// sanity check erase a deterministic finding (a real bug this fix's own
// design guards against -- see resolveOnePlatformMention's own comment).
//
// Both scenarios deliberately use a mention text that does NOT loosely
// substring-match the specific existing generation directly (different
// alternate code entirely, e.g. "Vynda" vs. "Fendrick") -- only the bare
// FAMILY label loosely matches (scenario A) or NOTHING matches at all
// (scenario B, relying purely on the same-make candidate fallback) -- so
// each scenario's outcome genuinely depends on whether the sanity check
// (and its retry) ran, not on the deterministic matcher already having
// solved it on its own.
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freshWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("d3.min.js");
  loadScript("data.js");
  return window;
}

// ---------- Scenario A: fails once (simulated 502), succeeds on retry ----------
{
  const window = freshWindow();
  const NAMEPLATE_ID = "m-test-retry-vorloch", FAM_ID = "fam-test-retry-blenko", GEN_ID = "m-test-retry-blenko-fendrick";

  // "Blenko Vynda" loosely matches the FAMILY ("Blenko") but not the
  // specific existing generation ("Blenko (Fendrick)") -- deterministic
  // matching alone would only ever get as far as the coarse family, never
  // the specific generation. Only the sanity check (surviving one retry)
  // can point directly at the real Fendrick generation.
  const WIKITEXT = "{{Infobox automobile\n| name = TestQzk Vorloch\n| production = 2010-2016\n}}\n" +
    "The TestQzk Vorloch shares its platform with the TestQzk Blenko Vynda.";
  let dupCallCount = 0;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const isDupCheck = body.messages[0].content.startsWith("You check whether a mentioned car");
      if (isDupCheck) {
        dupCallCount++;
        if (dupCallCount === 1) {
          // Simulate exactly the reported failure: a 502 from serve.py
          // because llama-server was transiently unreachable/still starting.
          return Promise.resolve({ ok: false, status: 502, json: async () => ({ error: "could not reach llama-server at http://127.0.0.1:8080" }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          matchId: GEN_ID, confidence: "high", reason: "Vynda is a market nickname for the Fendrick generation",
        }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestQzk Vorloch", yearStart: 2010, yearEnd: 2016, designers: [], engineers: [],
          sharedPlatforms: ["TestQzk Blenko Vynda"],
        }],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestQzk");
  if (!mk) { mk = { id: "mk-test-retry-qzk", type: "make", label: "TestQzk", year: 1950 }; DATA.nodes.push(mk); }
  const nameplate = { id: NAMEPLATE_ID, type: "model", label: "Vorloch", make: "TestQzk", wp: "TestQzk Vorloch", year: 2010, end: 2016 };
  const fam = { id: FAM_ID, type: "family", label: "Blenko", make: "TestQzk", year: 2000, end: null,
    designers: [], engineers: [], generations: [GEN_ID] };
  const gen = { id: GEN_ID, type: "model", label: "Blenko (Fendrick)", make: "TestQzk", year: 2008, end: 2015, familyOf: FAM_ID };
  DATA.nodes.push(nameplate, fam, gen);
  DATA.links.push(
    { source: NAMEPLATE_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: GEN_ID, type: "generation" },
  );

  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  window.CarWeb.boot();
  const cw = window.CarWeb;
  cw.setYearRange(1900, cw.yearRange().max);
  cw.setLlmCheck(true);
  cw.openDetail(nameplate);

  (async () => {
    await sleep(1200); // long enough to cover the ~500ms retry pause
    check("the duplicate-check call was attempted twice (first failed, retried once)", dupCallCount === 2, dupCallCount);

    // Real behavior change (task #106, multi-generation-pair support): this
    // key is scoped to the two specific generation ids involved (this
    // nameplate's own single generation, and the real GEN_ID it resolved
    // to) rather than the coarser whole-family id, so a different
    // generation independently finding its own platform partner gets its
    // own entry instead of colliding with this one.
    const relKey = [NAMEPLATE_ID, GEN_ID].sort().join("|") + "|platform";
    const rel = window.LlmFamilies.relationEntryFor(relKey);
    check("despite the transient 502, the retry succeeded and resolved onto the real specific generation " +
      "(not just the coarse family -- deterministic alone could never have gotten this specific)",
      !!rel && rel.genIdB === GEN_ID, rel);

    console.log("\n--- scenario A done ---");
    runScenarioB();
  })();
}

// ---------- Scenario B: fails BOTH times -- degrades gracefully, no crash/hang ----------
function runScenarioB() {
  const window = freshWindow();
  const NAMEPLATE_ID = "m-test-retry-prixmoor", FAM_ID = "fam-test-retry-yandrix", GEN_ID = "m-test-retry-yandrix-q8j";

  // "Corvenna" shares NO text overlap with "Yandrix" or "Yandrix (Q8j)" at
  // all -- deterministic matching finds nothing whatsoever here; the ONLY
  // way this mention's candidate list even includes the real Yandrix
  // family/generation is via buildDuplicateCandidates' same-make fallback.
  const WIKITEXT = "{{Infobox automobile\n| name = TestQzk Prixmoor\n| production = 2012-2018\n}}\n" +
    "The TestQzk Prixmoor shares its platform with the TestQzk Corvenna.";
  let dupCallCount = 0;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT } } }) });
    }
    if (u === "/api/llm/chat") {
      const body = JSON.parse(opts.body);
      const isDupCheck = body.messages[0].content.startsWith("You check whether a mentioned car");
      if (isDupCheck) {
        dupCallCount++;
        return Promise.resolve({ ok: false, status: 502, json: async () => ({ error: "could not reach llama-server" }) });
      }
      // Real user request (task #123): a newly-minted related car ("Corvenna"
      // here, once the fully-failed sanity check below degrades to a plain
      // mint) now gets its OWN background Wikipedia lookup + LLM check
      // (scheduleWpLookupAndCheck), independent of whatever check is already
      // in flight for the nameplate that mentioned it. Scoping this mock's
      // response to the specific car being asked about (the "Car: ..." line
      // every buildMessages() prompt starts its user turn with -- see its
      // own comment) keeps that unrelated background check a genuine no-op
      // (no further generations/platforms to report), so it can't cascade
      // into ANOTHER duplicate-check call and inflate dupCallCount -- this
      // test is specifically about counting THOSE calls, not about the
      // newly-minted node's own independent discovery flow.
      const userContent = body.messages[1].content;
      if (!userContent.startsWith("Car: TestQzk Prixmoor")) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: false, generations: [],
        }) } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        hasMultipleGenerations: false,
        generations: [{
          code: "TestQzk Prixmoor", yearStart: 2012, yearEnd: 2018, designers: [], engineers: [],
          sharedPlatforms: ["TestQzk Corvenna"],
        }],
      }) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };

  const DATA = window.CARDATA;
  let mk = DATA.nodes.find(n => n.type === "make" && n.label === "TestQzk");
  if (!mk) { mk = { id: "mk-test-retry-qzk", type: "make", label: "TestQzk", year: 1950 }; DATA.nodes.push(mk); }
  const nameplate = { id: NAMEPLATE_ID, type: "model", label: "Prixmoor", make: "TestQzk", wp: "TestQzk Prixmoor", year: 2012, end: 2018 };
  const fam = { id: FAM_ID, type: "family", label: "Yandrix", make: "TestQzk", year: 2000, end: null,
    designers: [], engineers: [], generations: [GEN_ID] };
  const gen = { id: GEN_ID, type: "model", label: "Yandrix (Q8j)", make: "TestQzk", year: 2010, end: 2017, familyOf: FAM_ID };
  DATA.nodes.push(nameplate, fam, gen);
  DATA.links.push(
    { source: NAMEPLATE_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: mk.id, type: "made" },
    { source: FAM_ID, target: GEN_ID, type: "generation" },
  );

  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
  loadScript("llm_families.js");
  loadScript("app.js");
  loadScript("timeline.js");
  loadScript("sixdeg.js");
  loadScript("platforms.js");

  window.CarWeb.boot();
  const cw = window.CarWeb;
  cw.setYearRange(1900, cw.yearRange().max);
  cw.setLlmCheck(true);
  cw.openDetail(nameplate);

  (async () => {
    await sleep(1200);
    check("the duplicate-check call was attempted twice then gave up (no infinite retry)", dupCallCount === 2, dupCallCount);

    const entry = window.LlmFamilies.entryFor(NAMEPLATE_ID);
    check("the overall check still completed normally -- no crash, no hang", !!entry, entry);

    // Deterministic matching found NOTHING for "Corvenna" either (no text
    // overlap with Yandrix at all), so with the sanity check having also
    // failed both attempts, this correctly falls through to the pre-
    // existing mint behavior -- proving a fully-failed sanity check
    // degrades to the OLD behavior rather than getting stuck or crashing.
    const minted = cw.nodes.find(n => /corvenna/i.test(n.label || ""));
    check("fully-failed sanity check falls back to the pre-existing mint behavior (graceful degradation)", !!minted, minted && minted.id);

    // And the real, untouched Yandrix family/generation must NOT have
    // acquired some bogus relation out of this -- nothing should point at
    // them at all from this mention.
    const relKey = [NAMEPLATE_ID, FAM_ID].sort().join("|") + "|platform";
    check("no spurious relation was created against the real (unrelated) Yandrix family", !window.LlmFamilies.relationEntryFor(relKey));

    console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
    process.exit(fails === 0 ? 0 : 1);
  })();
}
