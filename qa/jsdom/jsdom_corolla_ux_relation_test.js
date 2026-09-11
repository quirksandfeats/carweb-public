// Real bug report: opening the Toyota Corolla family with LLM Check on kept
// showing a "couldn't confidently match a specific generation pair" message
// for its connection to the Lexus UX (and separately, to the Corolla
// Cross), even though the REAL production dataset already has a specific,
// curated generation-level link -- Corolla (E210) <-> Lexus UX and Corolla
// (E210) <-> Corolla Cross -- sitting right there in cars.json (curated by
// data_src, nothing to do with the LLM layer at all). Root-caused to the
// exact same bug the Holden Nova case exposed (see
// jsdom_relation_already_resolved_model_test.js): unresolvedFamilyRelations
// only ever checked the LLM's OWN relation-store for a "confirmed" entry,
// blind to a plain-model connection ALREADY resolved by curated build-time
// data. This test proves the same fix (app.js's unresolvedFamilyRelations)
// also covers these two real production cases, using the REAL Corolla/
// UX/Corolla Cross nodes and links straight out of data.js -- not a
// synthetic fixture -- so it stands as a direct regression guard against
// this exact bug report recurring.
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

// Fresh llama.cpp stub for anything this test's own checks might still trigger
// (e.g. a pair NOT already covered by a curated link) -- uniformly "not
// confident", same reasoning as jsdom_relation_already_resolved_model_test.js.
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
// No pre-seeded LLM_FAMILIES entries -- this test wants to prove the fix
// works from the RAW curated graph data alone, with zero help from any
// already-confirmed LLM relation entry.
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

const corollaFam = cw.byId.get("fam-toyota-corolla");
const ux = cw.byId.get("m-lexus-ux");
const corollaCross = cw.byId.get("m-toyota-corolla-cross");
const e210 = cw.byId.get("m-toyota-corolla-e210");
check("real Toyota Corolla family node exists in the live dataset", !!corollaFam);
check("real Lexus UX node exists", !!ux);
check("real Toyota Corolla Cross node exists", !!corollaCross);
check("real Corolla (E210) generation node exists", !!e210, e210);

if (corollaFam && ux && corollaCross && e210) {
  const uxLink = cw.links.find(l => l.type === "related" &&
    ((l.sn === e210 && l.tn === ux) || (l.sn === ux && l.tn === e210)));
  check("precondition: a real curated E210 <-> Lexus UX link exists in cars.json", !!uxLink, uxLink);
  const crossLink = cw.links.find(l => l.type === "related" &&
    ((l.sn === e210 && l.tn === corollaCross) || (l.sn === corollaCross && l.tn === e210)));
  check("precondition: a real curated E210 <-> Corolla Cross link exists in cars.json", !!crossLink, crossLink);

  cw.openDetail(corollaFam);

  const uxBox = [...window.document.querySelectorAll(".dt-relations *")]
    .find(el => /Lexus UX/i.test(el.textContent || "") && /couldn.?t confidently match/i.test(el.textContent || ""));
  check("no 'couldn't confidently match' message for Lexus UX (already resolved via curated E210 link)", !uxBox, uxBox && uxBox.textContent);

  const crossBox = [...window.document.querySelectorAll(".dt-relations *")]
    .find(el => /Corolla Cross/i.test(el.textContent || "") && /couldn.?t confidently match/i.test(el.textContent || ""));
  check("no 'couldn't confidently match' message for Corolla Cross (already resolved via curated E210 link)", !crossBox, crossBox && crossBox.textContent);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
