// Pages Wikipedia deleted: the graph's cars keep what was checked elsewhere, and a
// link that led nowhere leads to what replaced the page.
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
const LIST = "List of Volkswagen Group petrol engines";
const line = (title, name, variant) => ({ title, name, variant, specs: { displacement: "2.5 L", layout: "I", cylinders: 5, fuel: "petrol" }, said: "2.5L Volkswagen EA855 TFSI I5" });
w.LLM_FAMILIES = { settings: { reviewedV: 3 }, rejectedRelations: {}, renames: {}, userCars: {}, wpLinks: {}, mintedFacts: {}, relations: {},
  families: {}, recheck: { "fam-holden-caprice": { status: "none" } },
  engineScans: { "m-audi-q3": { v: 7, checkedAt: "2026-10-01T00:00:00Z", sourceTitle: "Audi Q3", engines: [line("Volkswagen EA855", "EA855", null)] } },
  __serverAvailable: false };
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]))
  if (f !== "d3.min.js" && f !== "data.js" && !/llm_families_data/.test(f)) ev(f);
w.CarWeb.boot();
const by = id => w.CARDATA.nodes.find(n => n.id === id);
const id = v => typeof v === "string" ? v : v.id;
const fitted = n => w.CARDATA.links.filter(l => l.type === "fitted" && !l.retired && id(l.source) === n);

t("the PK4 ends when the Stoewer article says it does", by("m-stoewer-pk4").end === 1912, by("m-stoewer-pk4").end);
t("a make with no page links to its one car", by("mk-electrameccanica").wp === "ElectraMeccanica Solo" && by("mk-rambunctious").wp === "Rambunctious (Funny Car)");
t("those cars keep their own articles", by("m-electrameccanica-solo").wp === "ElectraMeccanica Solo" && by("m-rambunctious-funny-car").wp === "Rambunctious (Funny Car)");
t("the S07 is linked to the car it rebadges", w.CARDATA.links.some(l => l.type === "platform" && id(l.source) === "m-jetour-x70" && id(l.target) === "m-soueast-s07"));
t("the deleted EA855 page no longer makes an engine", !by("eng-volkswagen-ea855"));
const sec = w.CARDATA.nodes.find(n => n.type === "engine" && n.wp === LIST + "#EA855 R5");
t("the line lands on the list article's section", !!sec && fitted(sec.id).length === 1, sec && sec.id);
t("the car's own words stay on the line", sec && fitted(sec.id)[0].saidText === "2.5L Volkswagen EA855 TFSI I5");
t("a Multiplina or Emblème stays a car", !!by("m-fiat-multiplina") && !!by("m-renault-embleme"));
process.exit(fails ? 1 : 0);
