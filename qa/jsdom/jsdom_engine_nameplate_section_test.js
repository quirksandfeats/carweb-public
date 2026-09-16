// Real user report: "There are instances where there do not exist wikipedia
// pages on individual generations of cars. For example, the Chevrolet
// suburban. In this case, the terminal says this: [app] powertrain: Suburban
// First generation -- no article of its own to read engines from ... However,
// in the main wikipedia page for the chevrolet suburban, there exist
// individual generation 'cards' that display the engines for the subsequent
// generation being described... Maybe it's worth gathering this info from both
// possible locations and appending them to each other, if they exist in both
// places, obviously checking if there's overlap to prevent duplicate engines
// appearing for the same car."
//
// Those cards are per-generation {{Infobox automobile}} blocks: the Suburban's
// article carries twelve of them, each with its own `| engine =`. The scan gave
// up as soon as a generation had no article of its own, so none of it was ever
// read. Driven here by the real article.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const CACHE = path.join(ROOT, "qa", "wiki_cache");
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

const SUB = fs.readFileSync(path.join(CACHE, "Chevrolet_Suburban.wikitext"), "utf-8");

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });

// Only the nameplate's article exists. Every per-generation title 404s, which
// is the Suburban's real situation.
const asked = [];
window.fetch = (url) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    asked.push(title);
    if (title === "Chevrolet Suburban") {
      return Promise.resolve({ ok: true, json: async () =>
        ({ parse: { title, wikitext: { "*": SUB } } }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));

const FAM = "fam-chevy-suburban";
// Labelled as the LLM split actually labelled them, mislabel included: the
// generation it called "Third generation (1955)" is the article's FOURTH.
const GENS = [
  ["m-sub-g1", "Suburban First generation", 1935, 1940],
  ["m-sub-g3", "Suburban Third generation (1947)", 1947, 1955],
  ["m-sub-g4", "Suburban Third generation (1955)", 1955, 1960],
  ["m-sub-g9", "Suburban Ninth generation (2000)", 2000, 2006],
];
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-chevy2", type: "make", label: "Chevrolet", year: 1911 };
    D.nodes.push(mk, { id: FAM, type: "family", label: "Suburban", make: "Chevrolet",
                       wp: "Chevrolet Suburban", generations: GENS.map(g => g[0]),
                       designers: [], engineers: [] });
    D.links.push({ source: FAM, target: mk.id, type: "made" });
    GENS.forEach(([id, label, y, e]) => {
      // As applyFamilyOverride mints them: inheriting the nameplate's article.
      D.nodes.push({ id, type: "model", label, make: "Chevrolet", familyOf: FAM,
                     year: y, end: e, wp: "Chevrolet Suburban", designers: [], engineers: [] });
      D.links.push({ source: FAM, target: id, type: "generation" });
    });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- 1. finding the right section for each generation ----------
{
  const fam = cw.byId.get(FAM);
  const sec = label => {
    const s = LF.nameplateSectionForCar({ label, familyOf: FAM, type: "model" }, fam, SUB);
    return s && s.title;
  };
  check("a generation finds its own section in the nameplate's article",
        sec("Suburban First generation") === "First generation (1935)",
        sec("Suburban First generation"));
  check("...by the year it states, even when the ordinal disagrees",
        sec("Suburban Third generation (1955)") === "Fourth generation (1955)",
        sec("Suburban Third generation (1955)"));
  check("...and by the ordinal when there is no year",
        sec("Suburban Ninth generation") === "Ninth generation (2000)",
        sec("Suburban Ninth generation"));
  check("a generation that matches nothing gets no section rather than a guess",
        sec("Suburban Twentieth generation (1899)") === undefined ||
        sec("Suburban Twentieth generation (1899)") === null,
        sec("Suburban Twentieth generation (1899)"));
}

// ---------- 2. the engines those sections carry ----------
{
  const fam = cw.byId.get(FAM);
  const enginesIn = label => {
    const s = LF.nameplateSectionForCar({ label, familyOf: FAM, type: "model" }, fam, SUB);
    return s ? LF.engineMentions(s.body) : [];
  };
  const g9 = enginesIn("Suburban Ninth generation (2000)");
  check("the ninth generation's card names its engines", g9.length >= 4,
        g9.map(e => e.name).join(", "));
  check("...by their own articles, not by a description",
        g9.every(e => /engine/i.test(e.title)), g9.map(e => e.title).slice(0, 2).join(" | "));
  const g1 = enginesIn("Suburban First generation");
  check("an engine family named in words is read too -- the Stovebolt has no code",
        g1.some(e => /Stovebolt/.test(e.name)), g1.map(e => e.name).join(", "));
  const g4 = enginesIn("Suburban Third generation (1955)");
  check("...and one whose article title carries a parenthetical",
        g4.some(e => /small-block/.test(e.name)), g4.map(e => e.name).join(", "));
  check("...named as the engine, not as the whole article title",
        g4.every(e => !/\(first-/.test(e.name)), g4.map(e => e.name).join(", "));
  // The valvetrain and the cylinder layout are linked like engines in these
  // infoboxes and are not engines.
  const all = GENS.map(g => enginesIn(g[1])).reduce((a, b) => a.concat(b), []);
  check("a valvetrain is not recorded as an engine",
        !all.some(e => /^(OHV|overhead)/i.test(e.name)), all.map(e => e.name).join(", "));
  check("...nor is a cylinder layout",
        !all.some(e => /^(straight-six|inline-4|V8)$/i.test(e.name)), all.map(e => e.name).join(", "));
}

// ---------- 3. the scan, end to end ----------
(async () => {
  const fam = cw.byId.get(FAM);
  const before = DATA.links.filter(l => l.type === "fitted").length;
  const r = await LF.scanEnginesFor(fam, DATA.nodes, DATA.links);
  // Every generation the nameplate holds -- the baked graph carries a
  // Chevrolet Suburban model of its own that boot adopts into this family, so
  // the count is the family's, not just the four seeded here.
  check("every generation was looked at", r.scanned === fam.generations.length,
        r.scanned + " of " + fam.generations.length);
  check("...including each one seeded here",
        GENS.every(([id]) => !!LF.engineScanEntryFor(id)),
        GENS.map(([id]) => !!LF.engineScanEntryFor(id)).join(", "));
  check("...and engines were found, though not one has an article of its own",
        r.engines > 0 && r.fitted > 0, JSON.stringify(r));
  check("...connected to the generations, not the nameplate",
        DATA.links.filter(l => l.type === "fitted").length > before &&
        !DATA.links.some(l => l.type === "fitted" && (l.target === FAM || l.source === FAM)),
        DATA.links.filter(l => l.type === "fitted").length - before);
  check("the nameplate's article was read once, not once per generation",
        asked.filter(t => t === "Chevrolet Suburban").length === 1,
        asked.filter(t => t === "Chevrolet Suburban").length);
  check("no generation is left claiming it has no article to read from",
        GENS.every(([id]) => (LF.engineScanEntryFor(id) || {}).status !== "no-article"),
        GENS.map(([id]) => (LF.engineScanEntryFor(id) || {}).status).join(", "));
  check("...and each records which section it was read from",
        GENS.every(([id]) => {
          const e = LF.engineScanEntryFor(id);
          return e && (!e.engines.length || e.section);
        }),
        GENS.map(([id]) => (LF.engineScanEntryFor(id) || {}).section).join(" | "));

  // The merge rule: both places read, no duplicates.
  {
    const a = [{ title: "Chevrolet Stovebolt engine", name: "Stovebolt", variant: null },
               { title: "GMC V6 engine", name: "GMC V6", variant: null }];
    const b = [{ title: "Chevrolet Stovebolt engine", name: "Stovebolt", variant: null },
               { title: "Duramax V8 engine", name: "Duramax", variant: null }];
    const m = LF.mergeEngineHits(a, b);
    check("reading both places appends them", m.length === 3, m.map(x => x.name).join(", "));
    check("...without the overlap appearing twice",
          m.filter(x => x.name === "Stovebolt").length === 1, m.map(x => x.name).join(", "));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
