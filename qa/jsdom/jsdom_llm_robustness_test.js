// Four independently-reported LLM-layer bugs, each pinned down here.
//
// 1. "Local LLM relation check failed: JSON Parse error: Unrecognized token
//    '`'" -- a reply wrapped in a markdown code fence killed the whole check
//    even though valid JSON was sitting two characters in. (parseLlmJson)
//
// 2. Toyota 86: the model returned a correct, fully-sourced generation list
//    -- {"code": "ZN6/ZC6 (First generation)"}, {"code": "ZN8/ZD8 (Second
//    generation)"} -- and the hallucination guard dropped BOTH, reporting
//    "found no multiple generations here" with the real answer visible in
//    the "claimed but dropped" disclosure. The article contains "ZN6",
//    "ZC6" and a "First generation" heading, but never that exact composed
//    string. (codeAnchorIn)
//
// 3. Pontiac G5 / Marcos TSO: a pair with no note, no shared article text
//    and no chassis code in either article was still sent to the model,
//    which (correctly) answered "no source text note was provided... relying
//    solely on overlapping production years is explicitly forbidden". A full
//    round trip spent to be told what was already known. (checkRelation's
//    no-evidence short-circuit)
//
// 4. Ford Focus / VW Jetta: the model returned resolved:false with a long
//    explanation of why it could not map the codes -- and the connection
//    stayed on the graph anyway, then survived being deleted. ("it should
//    have automatically rejected the connection. However, it didn't... I
//    deleted it but it still appeared and didn't seem to actually get
//    deleted.")
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

function freshWindow(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = opts.fetchImpl || (() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  if (opts.seed) opts.seed(window.CARDATA);
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {}, __serverAvailable: true }, opts.llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  return window;
}

(async () => {
  // ================= 1. tolerant JSON parsing =================
  console.log("--- fenced / prose-wrapped JSON replies ---");
  {
    const window = freshWindow({});
    const LF = window.LlmFamilies;
    const want = { hasMultipleGenerations: true, generations: [{ code: "W463" }] };
    const eq = o => JSON.stringify(o) === JSON.stringify(want);

    check("plain JSON still parses", eq(LF.parseLlmJson(JSON.stringify(want))));
    check("```json fenced reply parses (the exact reported failure)",
      eq(LF.parseLlmJson("```json\n" + JSON.stringify(want) + "\n```")));
    check("bare ``` fenced reply parses", eq(LF.parseLlmJson("```\n" + JSON.stringify(want) + "\n```")));
    check("a leading prose preamble is tolerated",
      eq(LF.parseLlmJson("Here is the JSON you asked for:\n" + JSON.stringify(want))));
    check("trailing prose is tolerated",
      eq(LF.parseLlmJson(JSON.stringify(want) + "\n\nLet me know if you need anything else!")));
    // The guard must stay a guard: genuinely broken output still has to fail
    // loudly rather than be half-guessed at into something plausible.
    let threw = false;
    try { LF.parseLlmJson("```json\n{\"hasMultipleGenerations\": true, \"generations\": [{\"code\":\n```"); }
    catch (e) { threw = true; }
    check("genuinely malformed JSON still throws (not silently repaired)", threw);
    let threw2 = false;
    try { LF.parseLlmJson("I'm afraid I can't help with that."); } catch (e) { threw2 = true; }
    check("a reply with no JSON at all still throws", threw2);
  }

  // ================= 2. composite generation codes =================
  console.log("\n--- hallucination guard: components, not one composed string ---");
  {
    const window = freshWindow({});
    const LF = window.LlmFamilies;
    // A stand-in for the real Toyota 86 article: it names each chassis code
    // separately and has ordinal headings, but never the composed strings.
    const hay = ("The Toyota 86 was sold as the Scion FR-S. == First generation (ZN6) == " +
      "The ZN6 and its Subaru sibling the ZC6 arrived in 2012. == Second generation == " +
      "The ZN8 and ZD8 followed in 2021.").toLowerCase();

    check("the reported case is accepted: 'ZN6/ZC6 (First generation)'", LF.codeAnchorIn(hay, "ZN6/ZC6 (First generation)") >= 0);
    check("...and its sibling 'ZN8/ZD8 (Second generation)'", LF.codeAnchorIn(hay, "ZN8/ZD8 (Second generation)") >= 0);
    check("a plain code that IS verbatim still works", LF.codeAnchorIn(hay, "ZN6") >= 0);
    check("the anchor points at a real occurrence (so the per-generation photo lookup still works)",
      hay.slice(LF.codeAnchorIn(hay, "ZN6/ZC6 (First generation)")).startsWith("zn6"));
    // The guard still has to guard. Each of these has at least one component
    // that simply isn't in the source.
    check("a wholly invented code is still rejected", LF.codeAnchorIn(hay, "XX9") < 0);
    // Deliberately changed, 2026-08-27. This used to reject the whole code
    // when any half was unverifiable. Real cost of that rule: an Opel Astra
    // scan returned all six generations correctly, each written as the
    // generation letter joined to a platform code ("Astra F / T91"). The
    // letter is in the article, the platform code isn't, and all six were
    // discarded -- the app reported "no multiple generations here" for a car
    // that plainly has six.
    //
    // The guard's promise is that nothing invented reaches the graph, and it
    // still keeps it: only the verified half is STORED (codeVerifiedIn), so
    // "ZN6/XX9" is kept as "ZN6" and XX9 never appears anywhere. What changed
    // is that a real generation is no longer thrown away alongside it.
    check("a composite with one invented half is accepted on the strength of the real half",
      LF.codeAnchorIn(hay, "ZN6/XX9 (First generation)") >= 0);
    check("...but the invented half is not stored",
      LF.codeVerifiedIn(hay, "ZN6/XX9") === "ZN6", LF.codeVerifiedIn && LF.codeVerifiedIn(hay, "ZN6/XX9"));
    check("...and a composite with NO real half is still rejected outright",
      LF.codeAnchorIn(hay, "XX9/YY8") < 0);
    check("a non-generic parenthetical that isn't in the text is still rejected",
      LF.codeAnchorIn(hay, "ZN6 (Track Edition)") < 0);
    check("a non-generic parenthetical that IS in the text is accepted",
      LF.codeAnchorIn(hay, "ZN6 (Scion FR-S)") >= 0);
  }

  // ================= 3. no evidence -> no LLM call =================
  console.log("\n--- a pair with nothing to reason from is not sent to the model ---");
  {
    const FAM_A = "fam-test-rb-a", A1 = "m-test-rb-a1", A2 = "m-test-rb-a2";
    const FAM_B = "fam-test-rb-b", B1 = "m-test-rb-b1", B2 = "m-test-rb-b2";
    let relationCalls = 0;
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-rb", type: "make", label: "TestRb", year: 1960 };
        const famA = { id: FAM_A, type: "family", label: "Ayy", make: "TestRb", year: 2000, end: null, generations: [A1, A2] };
        const famB = { id: FAM_B, type: "family", label: "Bee", make: "TestRb", year: 2004, end: null, generations: [B1, B2] };
        DATA.nodes.push(mk, famA, famB,
          { id: A1, type: "model", label: "Ayy I", make: "TestRb", familyOf: FAM_A, year: 2000, end: 2010 },
          { id: A2, type: "model", label: "Ayy II", make: "TestRb", familyOf: FAM_A, year: 2010, end: null },
          { id: B1, type: "model", label: "Bee I", make: "TestRb", familyOf: FAM_B, year: 2004, end: 2014 },
          { id: B2, type: "model", label: "Bee II", make: "TestRb", familyOf: FAM_B, year: 2014, end: null });
        DATA.links.push(
          { source: FAM_A, target: mk.id, type: "made" }, { source: FAM_B, target: mk.id, type: "made" },
          { source: FAM_A, target: A1, type: "generation" }, { source: FAM_A, target: A2, type: "generation" },
          { source: FAM_B, target: B1, type: "generation" }, { source: FAM_B, target: B2, type: "generation" },
          // No note, and neither side has a `wp` -- exactly the Pontiac G5 /
          // Marcos TSO shape: nothing at all to resolve a generation pair from.
          { source: FAM_A, target: FAM_B, type: "related" });
      },
      fetchImpl: (url, opts) => {
        if (String(url) === "/api/llm/chat") {
          relationCalls++;
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: false, reason: "n/a" }) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    cw.setLlmCheck(true);
    cw.openDetail(cw.byId.get(FAM_A));
    await sleep(60);

    check("no llama.cpp call was spent on a pair with no evidence at all", relationCalls === 0, relationCalls);
    const key = [FAM_A, FAM_B].sort().join("|") + "|related";
    const entry = window.LlmFamilies.relationEntryFor(key);
    check("a 'none' verdict was still recorded (not silently skipped entirely)", entry && entry.status === "none", entry && entry.status);
    check("...flagged so the UI can explain WHY nothing was asked", entry && entry.noEvidence === true);
    check("...and its reason says so in plain language", entry && /nothing to resolve/i.test(entry.reason || ""), entry && entry.reason);
    // The user must still be able to override it by hand.
    const retryBtn = window.document.querySelector(".dt-relations .llm-rel-retry");
    check("a retry row is still offered, so a human hint can force a real check", !!retryBtn);
    const dbgBtn = window.document.querySelector(".dt-relations .llm-debug-toggle");
    check("the 'see what it said' disclosure still shows (it explains the skip)", !!dbgBtn);
    dbgBtn.onclick();
    const dbgBox = window.document.querySelector(".dt-relations .llm-debug");
    check("...and explains that the model was never asked", /never asked/i.test(dbgBox.innerHTML), dbgBox.innerHTML.slice(0, 160));
  }

  // ================= 4. resolved:false must not leave an edge behind =================
  console.log("\n--- an LLM-invented link the LLM then declines to back up is removed ---");
  {
    const FAM_F = "fam-test-fj-focus", F1 = "m-test-fj-f1", F2 = "m-test-fj-f2";
    const FAM_J = "fam-test-fj-jetta", J1 = "m-test-fj-j1", J2 = "m-test-fj-j2";
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-fj", type: "make", label: "TestFj", year: 1950 };
        DATA.nodes.push(mk,
          { id: FAM_F, type: "family", label: "Focusy", make: "TestFj", year: 1998, end: null, generations: [F1, F2] },
          { id: F1, type: "model", label: "Focusy Mk1", make: "TestFj", familyOf: FAM_F, year: 1998, end: 2004 },
          { id: F2, type: "model", label: "Focusy Mk2", make: "TestFj", familyOf: FAM_F, year: 2004, end: null },
          { id: FAM_J, type: "family", label: "Jetty", make: "TestFj", year: 1979, end: null, generations: [J1, J2] },
          { id: J1, type: "model", label: "Jetty A1", make: "TestFj", familyOf: FAM_J, year: 1979, end: 1984 },
          { id: J2, type: "model", label: "Jetty A2", make: "TestFj", familyOf: FAM_J, year: 1984, end: null });
        DATA.links.push(
          { source: FAM_F, target: mk.id, type: "made" }, { source: FAM_J, target: mk.id, type: "made" },
          { source: FAM_F, target: F1, type: "generation" }, { source: FAM_F, target: F2, type: "generation" },
          { source: FAM_J, target: J1, type: "generation" }, { source: FAM_J, target: J2, type: "generation" },
          // The exact shape resolveOnePlatformMention's coarse fallback
          // produces: llmDiscovered, with the mention text that created it.
          { source: FAM_J, target: FAM_F, type: "platform", llmDiscovered: true,
            note: "The design of the rear suspension has a strong resemblance to the one found in the Focusy." });
      },
      fetchImpl: (url, opts) => {
        if (String(url) === "/api/llm/chat") {
          // The verbatim shape of the reported reply: a careful, correct
          // refusal to map the codes.
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
            resolved: false, codeA: null, codeB: null, evidenceQuote: null,
            reason: "The note does not explicitly identify which specific generation shares this relationship, and year overlap alone is insufficient.",
          }) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    cw.setLlmCheck(true);

    const idOf = v => (typeof v === "string" ? v : (v && v.id));
    const coarse = cw.links.find(l => l.type === "platform" &&
      ((idOf(l.source) === FAM_J && idOf(l.target) === FAM_F) || (idOf(l.source) === FAM_F && idOf(l.target) === FAM_J)));
    check("fixture: the LLM-invented coarse link starts out live and visible", !!coarse && cw.linkInLayer(coarse));

    cw.openDetail(cw.byId.get(FAM_F));
    await sleep(80);

    check("after a resolved:false verdict, the invented link is severed", coarse.retired === true);
    check("...so it no longer draws (linkInLayer says no)", !cw.linkInLayer(coarse));
    const conns = [...window.document.querySelectorAll(".dt-connections .dt-conn")].map(b => b.textContent.trim());
    check("...and it's gone from the detail card's connections too", !conns.some(t => /Jetty/.test(t)), JSON.stringify(conns));
    const key = [FAM_F, FAM_J].sort().join("|") + "|platform";
    check("the rejected entry is gone from the store", !window.LlmFamilies.relationEntryFor(key));
    // ...and must STAY gone. Re-opening the panel used to restart the same
    // check on the severed link, which recreated the very entry the
    // rejection had just removed -- an endless propose/reject loop. The
    // retired flag is now honoured by unresolvedFamilyRelations too.
    cw.openDetail(cw.byId.get(FAM_J));
    cw.openDetail(cw.byId.get(FAM_F));
    await sleep(60);
    check("re-opening the panel does NOT restart the check on the severed link",
      !window.LlmFamilies.relationEntryFor(key), JSON.stringify(window.LlmFamilies.relationEntryFor(key)));

    // The blacklist has to be escapable, or "delete then re-run the LLM"
    // would be permanently poisoned -- see clearRejectionsFor. A non-zero
    // return is also proof the coarse nameplate-level key really was
    // recorded, which is what stops a later boot recreating the link.
    const cleared = window.LlmFamilies.clearRejectionsFor(FAM_F);
    check("the pair was blacklisted, and an explicit re-check clears that suppression again", cleared > 0, cleared);
  }

  // ================= 5. a genuine harvested fact is NEVER auto-deleted =================
  console.log("\n--- the same verdict on a build-time harvested link changes nothing ---");
  {
    const FAM_A = "fam-test-keep-a", A1 = "m-test-keep-a1", A2 = "m-test-keep-a2";
    const FAM_B = "fam-test-keep-b", B1 = "m-test-keep-b1", B2 = "m-test-keep-b2";
    const window = freshWindow({
      seed(DATA) {
        const mk = { id: "mk-test-keep", type: "make", label: "TestKeep", year: 1950 };
        DATA.nodes.push(mk,
          { id: FAM_A, type: "family", label: "Kay", make: "TestKeep", year: 2000, end: null, generations: [A1, A2] },
          { id: A1, type: "model", label: "Kay I", make: "TestKeep", familyOf: FAM_A, year: 2000, end: 2010 },
          { id: A2, type: "model", label: "Kay II", make: "TestKeep", familyOf: FAM_A, year: 2010, end: null },
          { id: FAM_B, type: "family", label: "Elle", make: "TestKeep", year: 2002, end: null, generations: [B1, B2] },
          { id: B1, type: "model", label: "Elle I", make: "TestKeep", familyOf: FAM_B, year: 2002, end: 2012 },
          { id: B2, type: "model", label: "Elle II", make: "TestKeep", familyOf: FAM_B, year: 2012, end: null });
        DATA.links.push(
          { source: FAM_A, target: mk.id, type: "made" }, { source: FAM_B, target: mk.id, type: "made" },
          { source: FAM_A, target: A1, type: "generation" }, { source: FAM_A, target: A2, type: "generation" },
          { source: FAM_B, target: B1, type: "generation" }, { source: FAM_B, target: B2, type: "generation" },
          // NO llmDiscovered flag -- this is a real DBpedia-harvested fact.
          { source: FAM_A, target: FAM_B, type: "platform", note: "Kay and Elle share a platform." });
      },
      fetchImpl: (url) => {
        if (String(url) === "/api/llm/chat") {
          return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
            resolved: false, codeA: null, codeB: null, reason: "cannot map the specific codes",
          }) } }] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      },
    });
    const cw = window.CarWeb;
    cw.boot();
    cw.setYearRange(1900, cw.yearRange().max);
    cw.setLlmCheck(true);
    const idOf = v => (typeof v === "string" ? v : (v && v.id));
    const harvested = cw.links.find(l => l.type === "platform" &&
      ((idOf(l.source) === FAM_A && idOf(l.target) === FAM_B) || (idOf(l.source) === FAM_B && idOf(l.target) === FAM_A)));
    cw.openDetail(cw.byId.get(FAM_A));
    await sleep(80);
    check("a harvested fact survives the same resolved:false verdict untouched", !harvested.retired && cw.linkInLayer(harvested));
    const box = window.document.querySelector(".dt-relations .llm-status");
    check("...and is reported as an unresolved pair, not as a removal",
      !!box && /couldn't confidently match/.test(box.textContent), box && box.textContent);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();

// Real bug report: an explicit LLM search on the Opel Astra ran twice, ~100s
// each, produced a full generation proposal both times, and the car stayed a
// plain model. The proposal was only ever held in memory, and only while the
// user was still looking at that exact panel -- so a reload mid-check threw
// away the whole thing silently.
//
// Also from that run: "Chevrolet Astra" asked four times, "Saturn Astra"
// three, "Opel Zafira B" three -- the same question re-asked at ~10s each.
{
  const src = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "..", "app", "llm_families.js"), "utf-8");
  const app = require("fs").readFileSync(
    require("path").resolve(__dirname, "..", "..", "app", "app.js"), "utf-8");
  check("a result the user explicitly asked for is written to disk",
    /if \(opts && opts\.explicit\) \{\s*\n\s*store\.families\[node\.id\] = entry;\s*\n\s*await persist\(\);/.test(src));
  check("...and idle browsing still discards an unasked-for one",
    /if \(engagedId === node\.id\) store\.families\[node\.id\] = entry;/.test(src));
  check("every user-initiated check marks itself explicit",
    (app.match(/checkNode\(n, nodes, \{ explicit: true \}\)/g) || []).length === 3,
    (app.match(/checkNode\(n, nodes, \{ explicit: true \}\)/g) || []).length);
  check("the same duplicate question isn't re-asked within a run",
    /const duplicateCheckCache = new Map\(\)/.test(src) &&
    /if \(duplicateCheckCache\.has\(cacheKey\)\) return duplicateCheckCache\.get\(cacheKey\)/.test(src));
  check("...but the cache key includes the candidates, so a changed graph re-asks",
    /const cacheKey = norm\(mentionText\) \+ "\|" \+ candidates\.map\(c => c\.id\)\.sort\(\)\.join\(","\)/.test(src));
  check("...and a failed check isn't cached as the answer",
    /p\.catch\(\(\) => duplicateCheckCache\.delete\(cacheKey\)\)/.test(src));
}
console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nALL GREEN");
process.exit(fails ? 1 : 0);
