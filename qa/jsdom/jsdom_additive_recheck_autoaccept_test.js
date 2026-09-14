// Real user request: "If the llm looks at a nameplate and finds from the
// wikipedia that there are more generations than currently listed, then
// automatically accept those changes and do not need to ask for my manual
// approval."
//
// Only that shape. applyFamilyOverride can also RETIRE generations, and a
// re-check that drops one is either the model misreading the article or a real
// editorial change -- both worth a human look, and neither what was asked for.
// So the rule is: every generation already on the nameplate still appears in
// Wikipedia's list, AND Wikipedia names at least one more. Anything else waits
// exactly as it did before.
//
// The matching is applyFamilyOverride's own code-normalised pairing, which is
// what stops "G01" and the existing "X3 (G01)" being read as two different
// generations -- get that wrong and a pure reformatting looks additive and
// applies itself.
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

const FAM = "fam-test-addrc";
const G1 = "m-test-addrc-mk1", G2 = "m-test-addrc-mk2";

function seed(DATA) {
  const mk = { id: "mk-test-addrc", type: "make", label: "TestAdd", year: 1960 };
  const fam = { id: FAM, type: "family", label: "Roadster", make: "TestAdd", year: 1990, end: null,
                designers: [], engineers: [], generations: [G1, G2], wp: "TestAdd Roadster" };
  const g1 = { id: G1, type: "model", label: "Roadster (MK1)", make: "TestAdd", year: 1990, end: 1999,
               familyOf: FAM, wp: "TestAdd Roadster (MK1)", designers: [], engineers: [] };
  const g2 = { id: G2, type: "model", label: "Roadster (MK2)", make: "TestAdd", year: 2000, end: 2009,
               familyOf: FAM, wp: "TestAdd Roadster (MK2)", designers: [], engineers: [] };
  DATA.nodes.push(mk, fam, g1, g2);
  DATA.links.push({ source: FAM, target: mk.id, type: "made" });
  DATA.links.push({ source: FAM, target: G1, type: "generation" });
  DATA.links.push({ source: FAM, target: G2, type: "generation" });
  DATA.links.push({ source: G1, target: G2, type: "gensucc" });
}

function gen(code, y0, y1) {
  return { code, yearStart: y0, yearEnd: y1, designers: [], engineers: [], sharedPlatforms: [] };
}
function entryWith(gens, discrepancy) {
  return {
    status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "TestAdd Roadster",
    proposal: { hasMultipleGenerations: true, generations: gens },
    discrepancy: discrepancy || "Wikipedia currently describes more generations than this nameplate shows",
    attempts: 1, feedback: [],
  };
}

function boot(recheckEntry) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.getBoundingClientRect = () =>
    ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  ev("d3.min.js"); ev("data.js");
  seed(window.CARDATA);
  window.LLM_FAMILIES = {
    families: {}, relations: {}, recheck: recheckEntry ? { [FAM]: recheckEntry } : {},
    __serverAvailable: true,
  };
  ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
  return window;
}

// ---------- 1. the verdict itself ----------
{
  const w = boot(entryWith([gen("MK1", 1990, 1999), gen("MK2", 2000, 2009), gen("MK3", 2010, null)]));
  const cw = w.CarWeb; cw.boot();
  const LF = w.LlmFamilies;
  const genNodes = [G1, G2].map(id => cw.byId.get(id));

  // Boot already swept it, so ask the verdict on a fresh, unapplied copy.
  const w2 = boot(entryWith([gen("MK1", 1990, 1999), gen("MK2", 2000, 2009), gen("MK3", 2010, null)]));
  const LF2 = w2.LlmFamilies;
  const v = LF2.additiveRecheck(FAM, [G1, G2].map(id => ({ id, label: "Roadster (" + (id.endsWith("mk1") ? "MK1" : "MK2") + ")" })));
  check("a list that keeps both generations and adds a third is additive", !!v, JSON.stringify(v));
  check("...and it says what was added", v && v.added.join(",") === "MK3", v && v.added.join(","));
  check("...and how the count moved", v && v.had === 2 && v.now === 3, v && (v.had + "->" + v.now));
}

// ---------- 2. applied without being asked ----------
{
  const w = boot(entryWith([gen("MK1", 1990, 1999), gen("MK2", 2000, 2009), gen("MK3", 2010, null)]));
  const cw = w.CarWeb; cw.boot();
  const fam = cw.byId.get(FAM);
  const e = w.LlmFamilies.recheckEntryFor(FAM);
  check("boot applied it on its own -- no panel opened, nothing clicked",
        e && e.status === "applied", e && e.status);
  check("...and the nameplate really gained the generation", fam.generations.length === 3,
        fam.generations.length + ": " + fam.generations.join(", "));
  check("...while keeping both of the ones it already had",
        fam.generations.includes(G1) && fam.generations.includes(G2), fam.generations.join(", "));
  const added = fam.generations.map(id => cw.byId.get(id)).find(n => n && /MK3/i.test(n.label));
  check("...as a real node with the year Wikipedia gave", added && added.year === 2010,
        added && added.label + " " + added.year);
  check("neither existing generation was retired",
        !cw.byId.get(G1).retired && !cw.byId.get(G2).retired);

  // Opening the car must show the applied state, not a decision to make.
  cw.setLlmCheck(true);
  cw.openDetail(fam);
  const yes = w.document.querySelector(".dt-llmcheck .llm-yes");
  check("the panel has nothing left to approve", !yes);

  // Idempotent: the sweep and the render path both re-run constantly.
  const before = fam.generations.length;
  cw.openDetail(fam);
  check("re-opening it does not add the generation twice", fam.generations.length === before,
        fam.generations.length + " vs " + before);
}

// ---------- 3. a re-check that DROPS one still waits ----------
{
  // Two listed, Wikipedia says one: the shape the BMW X3 bare-fold fix is
  // about, and the one that must never apply itself.
  const w = boot(entryWith([gen("MK1", 1990, 1999)], "an existing generation here is really just the bare nameplate"));
  const cw = w.CarWeb; cw.boot();
  const fam = cw.byId.get(FAM);
  const e = w.LlmFamilies.recheckEntryFor(FAM);
  check("a list that removes a generation is left provisional", e && e.status === "provisional", e && e.status);
  check("...and the nameplate is untouched until a person says so", fam.generations.length === 2,
        fam.generations.length);
  cw.setLlmCheck(true);
  cw.openDetail(fam);
  check("...and it is still put to the user as a choice",
        !!w.document.querySelector(".dt-llmcheck .llm-yes"));
  check("...with the Keep-what's-here option intact",
        !!w.document.querySelector(".dt-llmcheck .llm-no"));
}

// ---------- 4. same generations, spelled differently, is not "more" ----------
{
  // The code-normalised pairing is what carries this: the stored labels are
  // "Roadster (MK1)" / "Roadster (MK2)" and Wikipedia says "MK1" / "MK2".
  const w = boot(null);
  const cw = w.CarWeb; cw.boot();
  const LF = w.LlmFamilies;
  const nodes = [{ id: G1, label: "Roadster (MK1)" }, { id: G2, label: "Roadster (MK2)" }];
  w.LLM_FAMILIES.recheck[FAM] = entryWith([gen("MK1", 1990, 1999), gen("MK2", 2000, 2009)]);
  check("a proposal naming the same two generations is not additive",
        LF.additiveRecheck(FAM, nodes) === null);
  check("an empty proposal is not additive", LF.additiveRecheck(FAM, nodes) === null);
}

// ---------- 5. nothing to decide means nothing to do ----------
{
  const w = boot(null);
  const cw = w.CarWeb; cw.boot();
  check("a nameplate with no cross-check on file is left alone",
        w.LlmFamilies.additiveRecheck(FAM, []) === null);
  check("...and its generation list is unchanged", cw.byId.get(FAM).generations.length === 2);
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
