// The hallucination guard threw out real generations over how an article wrote
// a space, and over a remark in brackets it could not find. The Passat and the
// Jetta lost nearly all of theirs. What the model said is on file, so a load can
// read the answers again with no model.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const JETTA = "{{Infobox automobile|name=TestEv Jetta}}\n==First generation (A1, Type&nbsp;16; 1979)==\nBuilt 1979 to 1984.\n==Second generation (A2, Typ&nbsp;1G; 1984)==\nBuilt 1984 to 1992.\n==Third generation (A3; 1992)==\nBuilt 1992 to 1999.\n";
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window: w } = dom;
w.HTMLCanvasElement.prototype.getContext = fakeCtx;
w.requestAnimationFrame = () => 1;
w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
w.fetch = async url => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m && String(url).includes("prop=wikitext")) {
    const title = decodeURIComponent(m[1]);
    return { ok: true, json: async () => /Jetta/.test(title) ? { parse: { title, wikitext: { "*": JETTA } } } : { error: {} } };
  }
  return { ok: true, json: async () => ({}) };
};
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
w.CARDATA.nodes.push({ id: "mk-tev", type: "make", label: "TestEv" },
  { id: "m-tev-jetta", type: "model", label: "Jetta", make: "TestEv", year: 1979, end: 2019, wp: "TestEv Jetta" },
  { id: "m-tev-solo", type: "model", label: "Solo", make: "TestEv", year: 1979, end: 1999, wp: "TestEv Jetta" },
  { id: "m-tev-kept", type: "model", label: "Kept", make: "TestEv", year: 1979, end: 1999, wp: "TestEv Jetta" });
const raw = { hasMultipleGenerations: true, generations: [
  { code: "A1 (Type 16)", yearStart: 1979, yearEnd: 1984 }, { code: "A2 (Typ 1G facelift)", yearStart: 1984, yearEnd: 1992 },
  { code: "A3", yearStart: 1992, yearEnd: 1999 }, { code: "Z9 (Invented 3)", yearStart: 2000, yearEnd: 2001 } ] };
const split = gens => ({ hasMultipleGenerations: gens.length > 1, generations: gens });
const gen = (code, y0, y1) => ({ code, yearStart: y0, yearEnd: y1, designers: [], engineers: [], sharedPlatforms: [] });
w.LLM_FAMILIES = { families: {
  "m-tev-jetta": { status: "confirmed", sourceTitle: "TestEv Jetta", proposal: split([gen("A3", 1992, 1999), gen("Old", 2000, 2001)]), debug: { raw } },
  "m-tev-solo": { status: "none", sourceTitle: "TestEv Jetta", proposal: split([]), debug: { raw } },
  "m-tev-kept": { status: "confirmed", sourceTitle: "TestEv Jetta", proposal: split([gen("A1 (Type 16)", 1979, 1984), gen("A2", 1984, 1992), gen("A3", 1992, 1999)]), debug: { raw: { generations: raw.generations.slice(0, 3) } } },
}, recheck: {}, relations: {}, __serverAvailable: true };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies, S = w.LLM_FAMILIES;

const v = LF.validate(raw, JETTA).generations.map(g => g.code);
t("a space written as &nbsp; does not cost a generation", v.includes("A1 (Type 16)"), v.join());
t("a bracketed remark the article lacks is left off, and the code stays", v.includes("A2"), v.join());
t("an invented code is still dropped", !v.some(c => /Z9/.test(c)));
(async () => {
  const r = await LF.sweepDroppedGenerations(w.CarWeb.nodes);
  const codes = id => S.families[id].proposal.generations.map(g => g.code);
  t("a stored split gets its lost generations back", codes("m-tev-jetta").includes("A1 (Type 16)") && codes("m-tev-jetta").includes("A2"), codes("m-tev-jetta").join());
  t("...and what was on file stays, whatever the re-read says", codes("m-tev-jetta").includes("Old"));
  t("a car left with no generations becomes a split without asking", S.families["m-tev-solo"].status === "confirmed", S.families["m-tev-solo"].status);
  t("an answer that lost nothing is not touched", codes("m-tev-kept").join() === "A1 (Type 16),A2,A3");
  t("each answer is read once", S.families["m-tev-jetta"].droppedSweepV === 1 && r.recovered === 2, JSON.stringify(r));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
