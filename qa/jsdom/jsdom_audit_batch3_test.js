// Third audit round: generations another car wrongly took, end years, and what
// a model outage does to the to-do list. Each case comes from a finding checked
// against the real graph.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const gen = (code, y0, y1) => ({ code, yearStart: y0, yearEnd: y1, designers: [], engineers: [], sharedPlatforms: [] });
const split = gens => ({ status: "confirmed", decidedAt: "2026-10-01T00:00:00Z", sourceTitle: "x", proposal: { hasMultipleGenerations: true, generations: gens } });
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = fakeCtx;
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
const model = (slug, label, y0, y1) => ({ id: "m-tev-" + slug, type: "model", label, make: "TestEv", year: y0, end: y1, wp: "TestEv " + label });
D.nodes.push({ id: "mk-tev", type: "make", label: "TestEv" },
  model("astra", "Astra", 1984, 1995), model("torana", "Torana", 1967, 1980), model("camry", "Camry", 1990, 2024), model("focus", "Focus", 1998, null));
const applied = (gens, sections, extra) => Object.assign({ status: "applied", checkedAt: "2026-10-01", sourceTitle: "x", proposal: { generations: gens }, sections }, extra);
window.LLM_FAMILIES = { families: {
  "m-tev-astra": split([gen("LB, LC", 1984, 1987), gen("LD", 1987, 1989)]),
  "m-tev-torana": split([gen("LC", 1969, 1972), gen("LJ", 1972, 1974)]),
  "m-tev-camry": split([gen("XV70", 2017, 2024), gen("XV80", 2024, 2023)]),
  "m-tev-focus": split([gen("First", 1998, 2005), gen("Second", 2004, 2011), gen("Fourth", 2018, null)]),
}, recheck: {
  "m-tev-camry": applied([gen("XV70", 2017, 2024), gen("XV80", 2024, null)], [[1, "XV70 (2017–2024)"], [1, "XV80 (2024–present)"]]),
  "m-tev-focus": { status: "none", checkedAt: "2026-10-01", sourceTitle: "x", sections: [[1, "First"], [1, "Second"], [1, "Fourth"]],
    proposal: { generations: [gen("First", 1998, 2011), gen("Second", 2004, 2011), gen("Fourth", 2018, 2025)] } },
}, relations: {}, __serverAvailable: false };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
window.CarWeb.boot();
const LF = window.LlmFamilies, nodes = window.CarWeb.nodes;
const find = re => nodes.find(n => re.test(n.id));
const astra = find(/tev-astra.*lb/), torana = find(/tev-torana.*lc$/);
t("a code that is one part of a joined label does not hide that generation", astra && !astra.retired, astra && astra.id);
t("...and the other nameplate keeps its own", torana && !torana.retired);
const xv80 = find(/tev-camry-xv80/);
t("a heading saying present clears a stale end", xv80 && xv80.year === 2024 && xv80.end == null, xv80 && xv80.end);
const focus4 = find(/tev-focus-fourth/), focus1 = find(/tev-focus-first/);
t("a settled re-read still corrects an end when it agrees on the start", focus4 && focus4.end === 2025, focus4 && focus4.end);
t("...but not one running years past the next generation's start", focus1 && focus1.end === 2005, focus1 && focus1.end);

const sec = "==Production versions==\ntext\n===Series 1===\n[[TestEv XK engine|XK]]\n===Series 3===\n[[TestEv V12 engine|V12]]\n";
const s1 = LF.nameplateSectionForCar({ label: "Series 1", make: "TestEv" }, { label: "E-Type" }, sec);
t("a generation filed under a parent heading is found", s1 && s1.title === "Series 1", s1 && s1.title);
t("a hatnote with a named argument gives no title", LF.hatnoteArticle("{{main|l1=TestEv Teana (J31)}}") === null);
t("an image link is not an article", LF.proseArticle("[[File:TestEv Mirai JPD10 Cockpit.jpg|thumb]]", "TestEv", "JPD10", "Mirai") === null);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
