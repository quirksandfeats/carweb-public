// Nameplates whose first "generation" is the overview article under the nameplate's
// own name, reviewed on 2 Nov 2026: the CR-V and the Integra could not add what
// their articles list, the Type 2's section went unread, and the Porsche 911's
// overview stood beside the 911 (classic).
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window: w } = dom;
w.HTMLCanvasElement.prototype.getContext = fakeCtx;
w.requestAnimationFrame = () => 1;
w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
w.fetch = async () => ({ ok: true, json: async () => ({}) });
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
w.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies, nodes = w.CarWeb.nodes, links = w.CarWeb.links;
const gen = (code, yearStart, yearEnd) => ({ code, yearStart, yearEnd, designers: [], engineers: [], sharedPlatforms: [] });
const car = (id, label, year, end, more) => Object.assign({ id, type: "model", label, make: "TestBr", year, end, wp: "TestBr " + label }, more);
const decide = (fam, old, sections, fresh) => LF.decideRecheck(fam, old, { sections, sourceTitle: fam.wp, proposal: { generations: fresh } }, nodes);
const codes = l => l.map(x => x.code || x.label).join();

// The CR-V: an ordinal heading has no code to match, so its years answer for it.
const crv = { id: "f-crv", type: "family", label: "CR", make: "TestBr", wp: "TestBr CR" };
const crvOld = [car("g-crv1", "CR", 1995, 2001, { familyOf: "f-crv", wp: "TestBr CR" }), car("g-crv3", "CR (third generation)", 2006, 2012, { familyOf: "f-crv" })];
const crvHeads = [[1, "First generation (1995)"], [2, "Facelift"], [1, "Second generation (2002)"], [1, "Third generation (2007)"]];
let d = decide(crv, crvOld, crvHeads, [gen("RD1", 1995, 2001), gen("RD4", 2001, 2006), gen("RE1", 2006, 2012)]);
t("an ordinal heading takes a code the article does not use, on its years", codes(d.add) === "RD4", codes(d.add));
d = decide(crv, crvOld, crvHeads, [gen("RD1", 1995, 2001), gen("RD4", 2001, 2006), gen("ZZ9", 2003, 2005), gen("RE1", 2006, 2012)]);
t("...but not one whose years are elsewhere", !codes(d.add).includes("ZZ9"), codes(d.add));
// The Lancer's "GS platform": a heading that names its own code is not ordinal.
const lan = { id: "f-lan", type: "family", label: "LN", make: "TestBr", wp: "TestBr LN" };
d = decide(lan, [car("g-lan1", "LN (CS)", 2000, 2007, { familyOf: "f-lan" })],
  [[1, "Eighth generation (CS; 2000)"], [1, "Ninth generation (CY; 2007)"]], [gen("CS", 2000, 2007), gen("GS platform", 2007, 2017)]);
t("years alone still do not take a heading that names a code", !codes(d.add).includes("GS platform"), codes(d.add));
// The Caprice's series: the years must fit the whole section.
const cap = { id: "f-cap", type: "family", label: "CP", make: "TestBr", wp: "TestBr CP" };
d = decide(cap, [car("g-cap1", "CP (VQ)", 1990, 1999, { familyOf: "f-cap" })],
  [[1, "First generation (1990–1999)"], [1, "Second generation (1999–2006)"]], [gen("VQ", 1990, 1999), gen("WH", 1999, 2003)]);
t("a series inside an ordinal section does not stand for it", !codes(d.add).includes("WH"), codes(d.add));

// The Type 2's heading has a comment after it.
const T2 = "== First generation (T1; 1950) ==\ntext\n== Second generation (T2; 1967) == <!-- Courtesy note -->\ntext\n== Third generation (T3; 1979) ==\ntext\n";
const heads = LF.headingsOf(T2).map(h => h[1]);
t("a heading with a comment after it is read", heads.includes("Second generation (T2; 1967)"), heads.join(" | "));

// The 911: an overview a year before the first generation is that generation shown early.
const plate = (id, label, gens) => ({ id, type: "family", label, make: "TestBr", wp: "TestBr " + label, generations: gens });
nodes.push(plate("f-911", "9X", ["g-9x-classic", "g-9x-930"]),
  car("m-9x", "9X", 1963, 1964), car("g-9x-classic", "9X (classic)", 1964, 1989, { familyOf: "f-911", wp: "TestBr 9X (classic)" }),
  car("g-9x-930", "9X (930)", 1975, 1989, { familyOf: "f-911", wp: "TestBr 9X (930)" }),
  plate("f-van", "VT", ["g-vt-2005", "g-vt-2018"]), car("m-vt", "VT", 1972, 1973),
  car("g-vt-2005", "VT (2005)", 2005, 2018, { familyOf: "f-van", wp: "TestBr VT (2005)" }), car("g-vt-2018", "VT (2018)", 2018, null, { familyOf: "f-van", wp: "TestBr VT (2018)" }));
links.push({ source: "m-9x", target: "mk-testbr", type: "made" });
const pairs = LF.duplicateNameplatePairs(nodes);
LF.mergeDuplicateNameplates(nodes, links);
const by = id => nodes.find(n => n.id === id);
t("the fixture is a pair", pairs.some(p => p.dup.id === "m-9x") && pairs.some(p => p.dup.id === "m-vt"));
t("an overview a year before the first generation folds into the nameplate", by("m-9x").retired && by("m-9x").supersededBy === "f-911");
t("an earlier era stays a generation (the 1972 Vantage)", !by("m-vt").retired && by("m-vt").familyOf === "f-van");
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
