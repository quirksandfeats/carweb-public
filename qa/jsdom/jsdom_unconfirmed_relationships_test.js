// Real user request: "I want another menu that lets me see all of the
// unconfirmed relationships that I have not yet confirmed yet and were not
// automatically approved. If I click on one of these unconfirmed
// relationships it will then move the window viewfinder to focus on these
// two cars within the window." Verifies the new #unconfirmedrelbtn dropdown
// item (see app.js's initUnconfirmedRelPanel/Graph.focusPair): it only lists
// relation entries with status "provisional" (not "confirmed"/"none"/
// "error"), each row's label uses the two cars' real make+label, and
// clicking a row calls CarWeb.gotoPair which builds a TWO-node focus set
// directly from the given ids -- not the ordinary single-node
// focusOn/gotoNode, since an unconfirmed relation deliberately has no live
// graph link yet for an adjacency-based focus to find.
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

window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
const MAKE_ID = "mk-test-ucr-mazda", MAKE2_ID = "mk-test-ucr-ford";
let mazdaMake = DATA.nodes.find(n => n.id === MAKE_ID);
if (!mazdaMake) { mazdaMake = { id: MAKE_ID, type: "make", label: "TestMazdaUcr", year: 1950 }; DATA.nodes.push(mazdaMake); }
let fordMake = DATA.nodes.find(n => n.id === MAKE2_ID);
if (!fordMake) { fordMake = { id: MAKE2_ID, type: "make", label: "TestFordUcr", year: 1950 }; DATA.nodes.push(fordMake); }

const FAMILIA_ID = "fam-test-ucr-familia", ESCORT_ID = "fam-test-ucr-escort";
const familia = { id: FAMILIA_ID, type: "family", label: "FamiliaUcr", make: "TestMazdaUcr", year: 1963, end: null, designers: [], engineers: [], generations: [] };
const escort = { id: ESCORT_ID, type: "family", label: "EscortUcr", make: "TestFordUcr", year: 1968, end: null, designers: [], engineers: [], generations: [] };
DATA.nodes.push(familia, escort);
DATA.links.push(
  { source: FAMILIA_ID, target: MAKE_ID, type: "made" },
  { source: ESCORT_ID, target: MAKE2_ID, type: "made" },
);

// A THIRD entry with status "none" (LLM checked, found nothing) -- this
// must NOT show up in the panel, since it isn't "unconfirmed" in the user's
// sense (nothing is waiting on a yes/no from them for it).
const NOVA_ID = "fam-test-ucr-nova", CIVIC_ID = "fam-test-ucr-civic";
const nova = { id: NOVA_ID, type: "family", label: "NovaUcr", make: "TestMazdaUcr", year: 1975, end: null, designers: [], engineers: [], generations: [] };
const civic = { id: CIVIC_ID, type: "family", label: "CivicUcr", make: "TestFordUcr", year: 1975, end: null, designers: [], engineers: [], generations: [] };
DATA.nodes.push(nova, civic);
DATA.links.push(
  { source: NOVA_ID, target: MAKE_ID, type: "made" },
  { source: CIVIC_ID, target: MAKE2_ID, type: "made" },
);

// Two more fixture nodes for the inline Accept/Decline section below --
// seeded here, BEFORE boot(), like every other fixture in this file. Pushing
// new nodes into DATA.nodes/DATA.links AFTER window.CarWeb.boot() has
// already run does NOT retroactively register them in the live cw.byId/
// cw.adj (those are one-time snapshots built at boot from the DATA arrays),
// which was the root cause of an earlier crash here.
const DECLINE_A_ID = "fam-test-ucr-decline-a", DECLINE_B_ID = "fam-test-ucr-decline-b";
const declineMakeA = { id: "mk-test-ucr-declinea", type: "make", label: "TestDeclineA", year: 1950 };
const declineMakeB = { id: "mk-test-ucr-declineb", type: "make", label: "TestDeclineB", year: 1950 };
const declineA = { id: DECLINE_A_ID, type: "family", label: "DeclineFamA", make: "TestDeclineA", year: 1980, end: null, designers: [], engineers: [], generations: [] };
const declineB = { id: DECLINE_B_ID, type: "family", label: "DeclineFamB", make: "TestDeclineB", year: 1980, end: null, designers: [], engineers: [], generations: [] };
DATA.nodes.push(declineMakeA, declineMakeB, declineA, declineB);
DATA.links.push(
  { source: DECLINE_A_ID, target: declineMakeA.id, type: "made" },
  { source: DECLINE_B_ID, target: declineMakeB.id, type: "made" },
);

const relKey = (a, b, t) => [a, b].sort().join("|") + "|" + t;
const DECLINE_KEY = relKey(DECLINE_A_ID, DECLINE_B_ID, "related");
// DECLINE_KEY's relation entry is deliberately NOT seeded here -- the early
// "exactly one row shown" check below expects only the Familia/Escort pair
// to be provisional at boot. Its nodes/links ARE seeded above (before
// boot(), so cw.byId/cw.adj register them), and the relation entry itself
// gets added further down via a live store mutation, which is safe post-boot
// since it doesn't touch the node/adjacency indexes.
window.LLM_FAMILIES = {
  families: {}, recheck: {},
  relations: {
    [relKey(FAMILIA_ID, ESCORT_ID, "platform")]: {
      status: "provisional", famA: FAMILIA_ID, famB: ESCORT_ID, relType: "platform",
      checkedAt: "2024-01-01T00:00:00.000Z",
    },
    [relKey(NOVA_ID, CIVIC_ID, "related")]: {
      status: "none", famA: NOVA_ID, famB: CIVIC_ID, relType: "related",
      checkedAt: "2024-01-01T00:00:00.000Z",
    },
  },
  __serverAvailable: true,
};
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

const btn = window.document.getElementById("unconfirmedrelbtn");
check("the dropdown item is visible (server available)", !!btn && !btn.hidden);

btn.onclick();
const panel = window.document.getElementById("unconfirmedrel");
check("panel is open after clicking the item", panel && !panel.hidden);

const rows = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
check("exactly one row shown (only the 'provisional' entry, not the 'none' one)", rows.length === 1, rows.length);

const rowText = rows[0] && rows[0].textContent;
check("the row labels both real cars by make + label", !!rowText && /TestMazdaUcr FamiliaUcr/.test(rowText) && /TestFordUcr EscortUcr/.test(rowText), rowText);
check("the row shows the relationship type", !!rowText && /platform/.test(rowText), rowText);

// Real user request: "the user should directly be able to accept or
// decline this relationship" -- .ucr-row is now a plain container (not
// itself clickable, since it also holds two real inline action buttons a
// <button> can't legally nest) with a separate .ucr-pair-btn for the
// focus-the-graph interaction this test already covered.
const pairBtn = rows[0].querySelector(".ucr-pair-btn");
check("row has a dedicated clickable pair label (not the whole row itself, which now also holds Accept/Decline buttons)", !!pairBtn);
pairBtn.onclick();
check("panel closes after clicking the pair label", panel.hidden);

const focusSet = cw.graphFocusSet();
check("focus set contains BOTH cars from the unconfirmed pair", !!focusSet && focusSet.has(FAMILIA_ID) && focusSet.has(ESCORT_ID),
  focusSet && [...focusSet]);
check("clearfocus control is now shown", window.document.getElementById("clearfocus").hidden === false);

// ---------- inline Accept/Decline ----------
// Real user request: "within the 'unconfirmed relationships' dropdown
// button, the user should directly be able to accept or decline this
// relationship." Re-open the panel and exercise both inline buttons against
// two provisional entries (Accept on one, Decline on the other), with no
// detour through the graph/detail panel at all. Both entries (the original
// Familia/Escort pair and the Decline A/B pair) were seeded into
// window.LLM_FAMILIES.relations BEFORE boot(), so they're already part of
// the live store here.
const ACCEPT_KEY = relKey(FAMILIA_ID, ESCORT_ID, "platform");
// llm_families.js's own internal `store` already booted from the ORIGINAL
// window.LLM_FAMILIES snapshot and is a live, mutated-in-place object from
// then on -- app.js never re-reads window.LLM_FAMILIES again after boot, so
// this freshly-provisional entry is added the same way a real
// checkRelation() result would land: directly into that same live store.
// This is safe post-boot (unlike the node/link seeding above) since it only
// touches store.relations, not the node/adjacency indexes.
Object.assign(window.LLM_FAMILIES.relations, {
  [DECLINE_KEY]: { status: "provisional", famA: DECLINE_A_ID, famB: DECLINE_B_ID, relType: "related", checkedAt: "2024-01-01T00:00:00.000Z" },
});

btn.onclick(); // reopen with the panel's own refresh(), which re-reads allRelationEntries()
const rows2 = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
check("re-opened panel now shows 2 pending entries (the original one, plus the freshly-seeded decline-test one)",
  rows2.length === 2, rows2.length);

const acceptRow = rows2.find(r => /TestMazdaUcr FamiliaUcr/.test(r.textContent));
const declineRow = rows2.find(r => /TestDeclineA DeclineFamA/.test(r.textContent));
check("found the row to accept", !!acceptRow);
check("found the row to decline", !!declineRow);

acceptRow.querySelector(".ucr-yes").onclick();
const acceptedEntry = window.LlmFamilies.relationEntryFor(ACCEPT_KEY);
check("clicking Accept confirms the relation entry directly (status 'confirmed'), no detour through the graph needed",
  acceptedEntry && acceptedEntry.status === "confirmed", acceptedEntry);
const rowsAfterAccept = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
check("the accepted row disappears from the list immediately (list refreshes itself)",
  !rowsAfterAccept.some(r => /TestMazdaUcr FamiliaUcr/.test(r.textContent)), rowsAfterAccept.map(r => r.textContent));

declineRow.querySelector(".ucr-no").onclick();
const declinedEntry = window.LlmFamilies.relationEntryFor(DECLINE_KEY);
check("clicking Decline rejects the relation entry directly (no longer a pending provisional entry)",
  !declinedEntry || declinedEntry.status !== "provisional", declinedEntry);
const rowsAfterDecline = [...window.document.querySelectorAll("#unconfirmedrel-list .ucr-row")];
check("the declined row also disappears from the list immediately", rowsAfterDecline.length === 0, rowsAfterDecline.length);

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
