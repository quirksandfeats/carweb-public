// Real bug report: opening a nameplate family showed "couldn't confidently
// match a specific generation pair for the related connection to Holden
// Nova — it still shows at the nameplate level" even though a real,
// specific Holden Nova <-> Toyota Corolla (E100) link already exists and is
// live in the graph (Nova has no generations of its own -- a plain model,
// already as specific as that side can get). The message was both
// redundant (nothing left to disambiguate) and factually wrong (it does NOT
// still show only at the nameplate level -- the specific E100 link already
// supersedes the coarse one). unresolvedFamilyRelations() now skips a
// family<->model pair once any of the family's own generations already has
// a real link of that type directly to the model. A companion check proves
// this fix is properly SCOPED: a family<->FAMILY pair (where the other side
// can legitimately have several distinct valid pairings across different
// eras -- see jsdom_relation_disambiguation_test.js's Porsche 911/Boxster
// case) must still offer the disambiguation prompt even after one specific
// pair between them is already resolved.
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

const FAM_ID = "fam-test-arm-corolla", E90_ID = "m-test-arm-e90", E100_ID = "m-test-arm-e100";
const NOVA_ID = "m-test-arm-nova";
const FAM2_ID = "fam-test-arm-911", FAM2G1_ID = "m-test-arm-911-930", FAM2G2_ID = "m-test-arm-911-997";
const FAM3_ID = "fam-test-arm-boxster", FAM3G1_ID = "m-test-arm-boxster-981", FAM3G2_ID = "m-test-arm-boxster-987";

// Uniform "not confident" answer for anything asked -- this test only cares
// about WHICH pairs get offered a check at all (i.e. whether checkRelation
// is even invoked for them), not the resolution outcome itself.
window.fetch = (url) => {
  if (url === "/api/llm/chat") {
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: false, codeA: null, codeB: null, reason: "not confident" }) } }] }),
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
let toyotaMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestToyotaArm");
if (!toyotaMake) { toyotaMake = { id: "mk-test-arm-toyota", type: "make", label: "TestToyotaArm", year: 1950 }; DATA.nodes.push(toyotaMake); }
let holdenMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestHoldenArm");
if (!holdenMake) { holdenMake = { id: "mk-test-arm-holden", type: "make", label: "TestHoldenArm", year: 1950 }; DATA.nodes.push(holdenMake); }
let porscheMake = DATA.nodes.find(n => n.type === "make" && n.label === "TestPorscheArm");
if (!porscheMake) { porscheMake = { id: "mk-test-arm-porsche", type: "make", label: "TestPorscheArm", year: 1950 }; DATA.nodes.push(porscheMake); }

// ---------- scenario A: family <-> plain model (Holden Nova shape) ----------
const fam = { id: FAM_ID, type: "family", label: "CorollaArm", make: "TestToyotaArm", year: 1987, end: null,
  designers: [], engineers: [], generations: [E90_ID, E100_ID] };
const e90 = { id: E90_ID, type: "model", label: "CorollaArm (E90)", make: "TestToyotaArm", year: 1987, end: 1991, familyOf: FAM_ID };
const e100 = { id: E100_ID, type: "model", label: "CorollaArm (E100)", make: "TestToyotaArm", year: 1991, end: 1995, familyOf: FAM_ID };
const nova = { id: NOVA_ID, type: "model", label: "NovaArm", make: "TestHoldenArm", year: 1989, end: 1996 };
DATA.nodes.push(fam, e90, e100, nova);
DATA.links.push(
  { source: FAM_ID, target: toyotaMake.id, type: "made" },
  { source: NOVA_ID, target: holdenMake.id, type: "made" },
  { source: FAM_ID, target: E90_ID, type: "generation" },
  { source: FAM_ID, target: E100_ID, type: "generation" },
  { source: E90_ID, target: E100_ID, type: "gensucc" },
  // The real, specific curated link -- generation-level, direct to the plain model.
  { source: NOVA_ID, target: E100_ID, type: "related" },
  // The coarse, build-time-mirrored nameplate-level stand-in (mirror_relation_links).
  { source: NOVA_ID, target: FAM_ID, type: "related", mirror: true, mirrorTargetFam: FAM_ID },
);

// ---------- scenario B: family <-> family, one pair already resolved (Porsche 911/Boxster shape) ----------
const fam2 = { id: FAM2_ID, type: "family", label: "911Arm", make: "TestPorscheArm", year: 1963, end: null,
  designers: [], engineers: [], generations: [FAM2G1_ID, FAM2G2_ID] };
const g930 = { id: FAM2G1_ID, type: "model", label: "911Arm (930)", make: "TestPorscheArm", year: 1975, end: 1989, familyOf: FAM2_ID };
const g997 = { id: FAM2G2_ID, type: "model", label: "911Arm (997)", make: "TestPorscheArm", year: 2004, end: 2012, familyOf: FAM2_ID };
const fam3 = { id: FAM3_ID, type: "family", label: "BoxsterArm", make: "TestPorscheArm", year: 1996, end: null,
  designers: [], engineers: [], generations: [FAM3G1_ID, FAM3G2_ID] };
const g981 = { id: FAM3G1_ID, type: "model", label: "BoxsterArm (981)", make: "TestPorscheArm", year: 2012, end: 2016, familyOf: FAM3_ID };
const g987 = { id: FAM3G2_ID, type: "model", label: "BoxsterArm (987)", make: "TestPorscheArm", year: 2004, end: 2012, familyOf: FAM3_ID };
DATA.nodes.push(fam2, g930, g997, fam3, g981, g987);
DATA.links.push(
  { source: FAM2_ID, target: porscheMake.id, type: "made" },
  { source: FAM3_ID, target: porscheMake.id, type: "made" },
  { source: FAM2_ID, target: FAM2G1_ID, type: "generation" },
  { source: FAM2_ID, target: FAM2G2_ID, type: "generation" },
  { source: FAM2G1_ID, target: FAM2G2_ID, type: "gensucc" },
  { source: FAM3_ID, target: FAM3G1_ID, type: "generation" },
  { source: FAM3_ID, target: FAM3G2_ID, type: "generation" },
  { source: FAM3G1_ID, target: FAM3G2_ID, type: "gensucc" },
  // One real pair already resolved (997 <-> 987)...
  { source: FAM2G2_ID, target: FAM3G2_ID, type: "related" },
  // ...and the coarse family<->family mirror for it.
  { source: FAM2_ID, target: FAM3_ID, type: "related", mirror: true, mirrorSourceFam: FAM2_ID, mirrorTargetFam: FAM3_ID },
);

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);
cw.setLlmCheck(true);

const corollaFam = cw.byId.get(FAM_ID);
const p911Fam = cw.byId.get(FAM2_ID);

cw.openDetail(corollaFam);
const novaBoxAtOpen = [...window.document.querySelectorAll(".dt-relations *")]
  .find(el => /NovaArm/i.test(el.textContent || ""));
check("scenario A: no LLM status box even mentions NovaArm on open (pair never offered a check at all)", !novaBoxAtOpen, novaBoxAtOpen && novaBoxAtOpen.textContent);

// Real behavior change: LLM Check now auto-disengages the instant a fresh
// check is kicked off for a car (see app.js's disengageLlmCheckFor) -- and
// corollaFam above, itself a family with no recheck entry yet, already
// consumed that single arming for its OWN family-recheck. Selecting a
// SECOND, different nameplate (p911Fam) is a genuinely new choice, so it
// needs LLM Check re-armed first, exactly like a real user re-clicking the
// button before checking a second car.
cw.setLlmCheck(true);
cw.openDetail(p911Fam);
const boxsterBoxAtOpen = [...window.document.querySelectorAll(".dt-relations *")]
  .find(el => /BoxsterArm/i.test(el.textContent || "") && /checking/i.test(el.textContent || ""));
check("scenario B: a 'checking...' box for BoxsterArm appears immediately (pair still offered a check)",
  !!boxsterBoxAtOpen, boxsterBoxAtOpen && boxsterBoxAtOpen.textContent);

setTimeout(() => {
  // Re-open both panels after the stubbed (uniformly "not confident") LLM
  // calls have had a chance to resolve and persist, and confirm the
  // steady-state matches: Nova never shows up at all (never checked in the
  // first place), Boxster shows the real "none" UI (it WAS checked, and
  // this particular stub just wasn't confident) -- proving scenario B's
  // exhaustive-discovery behavior survives end to end, not just at the
  // "checking..." moment.
  cw.openDetail(corollaFam);
  const novaBoxAfter = [...window.document.querySelectorAll(".dt-relations *")]
    .find(el => /NovaArm/i.test(el.textContent || ""));
  check("scenario A after settling: still no NovaArm box of any kind", !novaBoxAfter, novaBoxAfter && novaBoxAfter.textContent);

  cw.openDetail(p911Fam);
  const boxsterBoxAfter = [...window.document.querySelectorAll(".dt-relations *")]
    .find(el => /BoxsterArm/i.test(el.textContent || "") && /couldn.?t confidently match/i.test(el.textContent || ""));
  check("scenario B after settling: BoxsterArm shows the real 'couldn't confidently match' UI (genuinely checked, not suppressed)",
    !!boxsterBoxAfter, boxsterBoxAfter && boxsterBoxAfter.textContent);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}, 80);
