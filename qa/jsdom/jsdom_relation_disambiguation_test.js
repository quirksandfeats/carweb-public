// Verifies task #56's LLM disambiguation half: when the user opens a
// family with a platform/related/succession connection to ANOTHER
// multi-generation family, the app should (with LLM Check on) ask the
// local LLM which specific generation pair the relationship is really
// about, show a Yes/No provisional block, and on Yes wire in the resolved
// generation<->generation link WITHOUT deleting the original -- the
// original just becomes hidden once either family is expanded (reusing
// the same precedence machinery task #53/#60 already built).
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
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
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

let lastOllamaBody = null;
window.fetch = (url, opts) => {
  if (url === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    // Porsche 911 also carries a pile of OTHER platform/related/succession
    // links (911 GT3, the "911 (classic)" umbrella article, several RUF
    // rebadges...) — task #61's plain-model-target disambiguation (app.js's
    // unresolvedFamilyRelations/relationGenInfo) now offers to disambiguate
    // ALL of those too, not just the Boxster/Cayman family pair, since a
    // family<->model connection benefits from being pinned to the family's
    // own specific generation even when the model side has nothing to
    // disambiguate. A real Ollama model would only confidently say
    // "resolved: true" for the pair it's actually being asked about; mimic
    // that here by only returning the stubbed answer for the genuine
    // Boxster/Cayman request (identifiable by its family label appearing in
    // the outgoing prompt) and a firm "not confident" for every other one —
    // otherwise every one of those other pairs would ALSO resolve, and
    // whichever renders first in the DOM (not necessarily Boxster/Cayman)
    // would be the one this test's Yes click actually confirms.
    const isBoxsterFamilyPair = JSON.stringify(body.messages).includes("Boxster and Cayman");
    if (isBoxsterFamilyPair) lastOllamaBody = body;
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(
        isBoxsterFamilyPair ? window.__stubOllamaAnswer
          : { resolved: false, codeA: null, codeB: null, reason: "not confident about this pair" }
      ) } }] }),
    });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window;
global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
window.LLM_FAMILIES = { families: {}, relations: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
cw.setLlmCheck(true);

const p911 = cw.byId.get("fam-porsche-911");
const boxster = cw.byId.get("fam-porsche-boxster-and-cayman");
check("Porsche 911 / Boxster-Cayman family precondition", !!p911 && !!boxster);
const mirrorLink = cw.links.find(l => l.type === "related" && l.mirror &&
  ((l.sn === p911 && l.tn === boxster) || (l.sn === boxster && l.tn === p911)));
check("family<->family mirror connection exists (test precondition, from task #56's build-time pass)", !!mirrorLink);

const codeA = p911.generations && cw.byId.get(p911.generations[0]).label;
const codeB = boxster.generations && cw.byId.get(boxster.generations[0]).label;
// `reason` deliberately reads as genuine article evidence rather than a
// bare date-overlap guess -- see llm_families.js's reasonLooksDateOnly,
// which now declines to trust a resolved:true verdict backed by nothing
// but "the years line up" when there's no other evidence (this test mocks
// away the Wikipedia fetch entirely, so there's never any deterministic
// evidence here either).
// The wording here is load-bearing for a second reason as of the
// citation-backed auto-confirm tier (real user request, on an Acura Legend /
// RL KA9 verdict: "this should be sufficient information for the program to
// automatically approve this relationship. I shouldn't have to approve it
// myself"): a reason that attributes the claim to one of the two ARTICLES and
// names a code from the real list now confirms outright, with no Yes/No to
// click. This test is about the disambiguation REVIEW flow, so its stub states
// a bare conclusion instead of citing a source -- which is exactly the kind of
// answer that should still be reviewed.
window.__stubOllamaAnswer = { resolved: true, codeA, codeB, reason: "Stubbed test answer: this 911 generation is the platform donor." };

// A note on the link under test is load-bearing as of the no-evidence
// short-circuit in llm_families.js's checkRelation (real user report: "the
// LLM tried to check a relationship between the Pontiac G5 and the Marcos
// TSO, even though it knew they weren't related"). A pair with no note, no
// article text naming the other car, and no chassis code found in either one
// now returns "none" without calling the model at all -- and this test mocks
// the Wikipedia fetch away entirely, so there is never any article evidence
// to gather here. Stamped directly onto the real build-time mirror link,
// which is what app.js's unresolvedFamilyRelations reads the note off. Note
// this deliberately does NOT stamp the 911's many OTHER relation links (911
// GT3, the RUF rebadges, the "911 (classic)" umbrella), so those still take
// the short-circuit -- which is exactly the isolation this test wanted from
// its stub in the first place.
mirrorLink.note = "The Boxster/Cayman shares its platform with the 911 of the same era.";

cw.openDetail(p911);
const box = window.document.querySelector(".dt-relations .llm-status");
check("a 'checking...' status shows up in the relations panel immediately on open", !!box, box && box.textContent);

// checkRelation() is async (awaits the stubbed fetch) -- wait a tick for it
// to resolve and re-render before checking the provisional UI.
setTimeout(() => {
  const provisionalLabel = window.document.querySelector(".dt-relations .llm-label");
  check("provisional relation match rendered after the stubbed LLM call resolves", !!provisionalLabel, provisionalLabel && provisionalLabel.textContent);
  check("the outgoing Ollama prompt included both families' real generation codes",
    !!lastOllamaBody && JSON.stringify(lastOllamaBody.messages).includes(codeA) && JSON.stringify(lastOllamaBody.messages).includes(codeB));

  const yesBtn = window.document.querySelector(".dt-relations .llm-rel-yes");
  check("Yes/No buttons rendered", !!yesBtn);
  const linksBefore = cw.links.length;
  yesBtn.onclick();

  const genA = cw.byId.get(p911.generations[0]);
  const genB = cw.byId.get(boxster.generations[0]);
  const resolvedLink = cw.links.find(l => l.type === "related" && l.llmResolved &&
    ((l.sn === genA && l.tn === genB) || (l.sn === genB && l.tn === genA)));
  check("the resolved generation<->generation link was created", !!resolvedLink);
  check("link count grew by exactly one (only the new resolved link, nothing else added)", cw.links.length === linksBefore + 1, cw.links.length - linksBefore);

  const origAfter = cw.links.find(l => l === mirrorLink);
  check("the ORIGINAL family<->family mirror link still exists (never deleted)", !!origAfter);

  // ---------- the panel must show SOMETHING after confirming, not go silently blank ----------
  // This is what a real bug report actually described: clicking Yes made
  // the panel go empty with no sign anything happened, which -- even though
  // the underlying link WAS created (checked above) -- reads exactly like
  // the action silently failed.
  cw.openDetail(p911); // re-render, same as clicking Yes already triggers via applyRelationConfirm
  const resolvedConfirmation = window.document.querySelector(".dt-relations .llm-resolved");
  check("a persistent '✓ resolved' confirmation is shown, not a blank panel", !!resolvedConfirmation, resolvedConfirmation && resolvedConfirmation.textContent);
  check("the confirmation doesn't just repeat the family name twice",
    !(resolvedConfirmation && /(\b[\w' ]+\b)\s+\1/i.test(resolvedConfirmation.textContent)),
    resolvedConfirmation && resolvedConfirmation.textContent);

  // ---------- precedence: collapsed shows the (now retagged) original; expanded shows the resolved link, not both ----------
  check("COLLAPSED: original still reachable", cw.linkInLayer(mirrorLink) && cw.nodeInLayer(mirrorLink.sn) && cw.nodeInLayer(mirrorLink.tn));
  cw.expandFamily(p911.id);
  cw.expandFamily(boxster.id);
  check("EXPANDED both sides: original mirror is now hidden (superseded)", !cw.linkInLayer(mirrorLink));
  check("EXPANDED both sides: the newly-resolved generation link is reachable",
    cw.linkInLayer(resolvedLink) && cw.nodeInLayer(resolvedLink.sn) && cw.nodeInLayer(resolvedLink.tn));

  // ---------- reject path: a fresh unrelated relation, answered No ----------
  cw.collapseFamily(p911.id);
  cw.collapseFamily(boxster.id);
  const rejKey = [p911.id, boxster.id].sort().join("|") + "|related";
  const relEntry = window.LlmFamilies.relationEntryFor(rejKey);
  check("relation entry persisted with status confirmed", relEntry && relEntry.status === "confirmed");

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}, 50);
