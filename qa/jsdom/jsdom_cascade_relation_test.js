// Verifies "cascading nameplate discovery": when a family the user is
// looking at (with LLM Check on) carries a coarse platform/related/
// succession connection to a DIFFERENT, still-plain model that's never been
// checked for hidden generations, the relation-check UI proactively checks
// that other model too -- not just once the user happens to open ITS detail
// panel separately. If it turns out to also be a real nameplate, accepting
// the proposal splits it in place (without hijacking the currently-open
// panel) and the relationship then resolves to a genuine generation<->
// generation pair, exactly like two build-time nameplates already would.
//
// Mirrors a real bug report: BMW X3 (once corrected into real generations)
// carries a "related" connection to a BMW X4 that's still just one plain
// model -- opening X3 should discover X4 (G01)/(G02) too and end up with
// "X3 (G01) <-> X4 (G02)", not a dead-ended "X3 (G01) <-> X4 (the whole
// model)".
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

// ---------- fetch stub: Wikipedia article digest + llama.cpp, differentiated by content ----------
const X4_WIKITEXT = "{{Infobox automobile\n| name = TestBMW X4\n}}\nThe first generation G01 was launched in 2018 as a coupe-SUV. " +
  "The second generation G02 followed in 2023 with updated styling. It was designed by Test X4 Designer.";
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) {
    return Promise.resolve({
      ok: true,
      json: async () => ({ parse: { wikitext: { "*": X4_WIKITEXT } } }),
    });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    const msgText = JSON.stringify(body.messages);
    if (msgText.includes("You extract car production-generation data")) {
      // Generation-extraction call -- this is the cascade check on X4.
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          hasMultipleGenerations: true,
          generations: [
            { code: "G01", yearStart: 2018, yearEnd: 2023, designers: [], engineers: [], sharedPlatform: null },
            { code: "G02", yearStart: 2023, yearEnd: null, designers: ["Test X4 Designer"], engineers: [], sharedPlatform: null },
          ],
        }) } }] }),
      });
    }
    // Relation-disambiguation call -- both sides are real nameplates now.
    // codeB must exactly match the code checkRelation will actually offer,
    // i.e. the generation's own graph label ("<model label> <code>", see
    // applyConfirmed in llm_families.js: `${orig.label} ${g.code}`) -- NOT
    // some arbitrary made-up string. codeA is irrelevant to matching here
    // since X3 has only one generation (auto-selected, single-option side).
    // `reason` deliberately reads as genuine article evidence, not a bare
    // date-overlap guess -- see llm_families.js's reasonLooksDateOnly,
    // which now declines to trust a resolved:true verdict backed by
    // nothing but "the years line up" when there's no other evidence.
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        resolved: true, codeA: "X3 G01", codeB: "X4 G02", reason: "the X4 article explicitly states it shares its platform with the X3 G01",
      }) } }] }),
    });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

// ---------- seed X3 (already a family, one known generation) related to a still-plain X4 ----------
const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestBMW");
if (!makeNode) { makeNode = { id: "mk-testbmw2", type: "make", label: "TestBMW", year: 1916 }; DATA.nodes.push(makeNode); }
const famX3 = { id: "fam-test-x3-cascade", type: "family", label: "X3", make: "TestBMW", year: 2017, end: null,
  designers: [], engineers: [], generations: ["m-test-x3-g01"] };
const x3g01 = { id: "m-test-x3-g01", type: "model", label: "X3 (G01)", make: "TestBMW", year: 2017, end: null,
  familyOf: "fam-test-x3-cascade", wp: "TestBMW X3 (G01)", designers: [], engineers: [] };
const x4Plain = { id: "m-test-x4", type: "model", label: "X4", make: "TestBMW", year: 2018, end: null, wp: "TestBMW X4" };
DATA.nodes.push(famX3, x3g01, x4Plain);
DATA.links.push({ source: "fam-test-x3-cascade", target: makeNode.id, type: "made" });
DATA.links.push({ source: "fam-test-x3-cascade", target: "m-test-x3-g01", type: "generation" });
DATA.links.push({ source: "m-test-x4", target: makeNode.id, type: "made" });
// The coarse, pre-existing fact: X3 (the whole nameplate) relates to X4 (the
// whole, still-ungrouped model) -- exactly what a build-time harvest or an
// earlier LLM pass would have left behind before X4 was ever looked at.
DATA.links.push({ source: "fam-test-x3-cascade", target: "m-test-x4", type: "related" });

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setLlmCheck(true);
const x3 = cw.byId.get("fam-test-x3-cascade");
const x4 = cw.byId.get("m-test-x4");
check("precondition: X4 starts as a plain, ungrouped model", x4.type === "model" && !x4.familyOf);

cw.openDetail(x3);
const cascadeStatus = window.document.querySelector(".dt-relations .llm-status");
check("cascade check kicked off immediately for the related plain model", !!cascadeStatus &&
  cascadeStatus.textContent.includes("also a nameplate"), cascadeStatus && cascadeStatus.textContent);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // Real user request: a plain model becoming a nameplate for the first
  // time needs no manual approval -- the cascade discovery here auto-
  // applies immediately instead of showing a Yes/No proposal, and the
  // relation-disambiguation follow-on check kicks off in the same async
  // chain, so one longer wait covers both.
  await sleep(150);
  check("no cascade Yes/No proposal ever shown -- auto-applied without approval",
    !window.document.querySelector(".dt-relations .llm-cascade-yes"));
  check("X4 became a real family automatically", x4.type === "family", x4.type);
  check("X4 has 2 generations now", x4.generations && x4.generations.length === 2, x4.generations);
  check("the currently-open panel is STILL X3, not hijacked to X4", window.document.querySelector(".dt-title").textContent.includes("X3"),
    window.document.querySelector(".dt-title").textContent);
  // Splitting X4 immediately re-renders this same box into the normal
  // relation-disambiguation flow (proceedWithRelationCheck) -- give its
  // async checkRelation call a tick to resolve.
  await sleep(300);
  const relLabel = window.document.querySelector(".dt-relations .llm-label");
  check("now offers a genuine generation<->generation disambiguation (not a dead-end plain-model match)",
    !!relLabel && relLabel.textContent.includes("related connection"), relLabel && relLabel.textContent);

  const relYes = window.document.querySelector(".dt-relations .llm-rel-yes");
  check("relation Yes button rendered", !!relYes);
  const linksBefore = cw.links.length;
  relYes.onclick();

  const genA = cw.byId.get("m-test-x3-g01");
  const x4g02 = x4.generations.map(id => cw.byId.get(id)).find(g => g.label.includes("G02"));
  check("X4's G02 generation exists and carries its own designer credit",
    !!x4g02 && x4g02.designers && x4g02.designers.includes("Test X4 Designer"), x4g02 && x4g02.designers);
  const resolvedLink = cw.links.find(l => l.type === "related" && l.llmResolved &&
    ((l.sn === genA && l.tn === x4g02) || (l.sn === x4g02 && l.tn === genA)));
  check("final resolved link is X3 (G01) <-> X4 (G02), a real generation<->generation pair", !!resolvedLink);
  check("link count grew by exactly one for this resolution", cw.links.length === linksBefore + 1, cw.links.length - linksBefore);

  // designer/engineer follow-through: X4 (G02)'s designer credit should
  // also be reachable as a real graph connection, not just text.
  const designerLink = cw.links.find(l => l.type === "designed" && l.sn === x4g02 && l.tn && l.tn.label === "Test X4 Designer");
  check("X4 (G02)'s designer is wired as a real graph link, not just a text field", !!designerLink);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
