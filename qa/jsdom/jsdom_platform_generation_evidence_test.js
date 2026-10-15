// Which generation of another nameplate a platform mention means, when the
// mention names only the nameplate. The owner's order (14-15 Oct 2026):
// evidence first -- a code or place the mention names, then the generation
// whose own section of its article names this car back -- and only then the
// years; never the bare nameplate where a generation can be named. The case
// on record: the Hyundai Galloper's second generation was put on the Pajero's
// third by years; the Pajero's first and second generations name the Galloper.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
function fakeCtx() { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); }
const gen = (code, y0, y1, sp) => ({ code, yearStart: y0, yearEnd: y1, designers: [], engineers: [], sharedPlatforms: sp || [] });
const split = gens => ({ status: "confirmed", decidedAt: "2026-10-01T00:00:00Z", sourceTitle: "x", proposal: { hasMultipleGenerations: true, generations: gens } });

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const D = window.CARDATA;
D.nodes.push({ id: "mk-tev", type: "make", label: "TestEv" },
  { id: "m-tev-pajero", type: "model", label: "Pajero", make: "TestEv", year: 1982, end: 2021, wp: "TestEv Pajero" },
  { id: "m-tev-galloper", type: "model", label: "Galloper", make: "TestEv", year: 1991, end: 2004, wp: "TestEv Galloper" },
  { id: "m-tev-sport", type: "model", label: "Sport", make: "TestEv", year: 1996, end: 2001, wp: "TestEv Sport" });
window.LLM_FAMILIES = { families: {
  "m-tev-pajero": split([gen("First generation", 1982, 1991, ["TestEv Galloper"]), gen("Second generation", 1991, 1999, ["TestEv Galloper"]),
                         gen("Third generation", 1999, 2006), gen("Fourth generation", 2006, 2021)]),
  "m-tev-galloper": split([gen("First generation", 1991, 1997), gen("Second generation", 1997, 2004, ["TestEv Pajero"])]),
  "m-tev-sport": split([gen("Mk1", 1996, 1998, ["TestEv Pajero (second generation)"]), gen("Mk2", 1998, 2001)]),
}, relations: {}, recheck: {}, __serverAvailable: false };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
window.CarWeb.boot();
const R = window.LLM_FAMILIES.relations;
// The relation written from `a`'s own mention (famA is the car whose article was read).
const pair = (a, b) => Object.values(R).find(e => e.famA && e.famA.includes(a.split("-")[0]) &&
  [e.genIdA, e.genIdB].some(x => x && x.includes(a)) && [e.genIdA, e.genIdB].some(x => x && x.includes(b)));
const other = (e, a) => [e.genIdA, e.genIdB].find(x => !x.includes(a));
const between = (a, b) => Object.values(R).filter(e => [e.genIdA, e.genIdB].some(x => x && x.includes(a)) && [e.genIdA, e.genIdB].some(x => x && x.includes(b)));
t("the Galloper's second generation is not put on the Pajero built alongside it (the third)", between("galloper-second", "pajero-third").length === 0);
const g2 = between("galloper-second", "pajero-second")[0];
t("...but on a Pajero generation whose own section names it", !!g2, JSON.stringify(Object.keys(R)));
const s1 = pair("sport-mk1", "pajero");
t("a mention naming the generation by its place is followed", s1 && /pajero-second/.test(other(s1, "sport")), s1 && other(s1, "sport"));
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
