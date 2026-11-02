// What a mention becomes when the graph does not know its first word. The first
// word became a make, whatever it was: 17 of the 79 made that way were not makes.
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
const gen = (code, yearStart, yearEnd) => ({ code, yearStart, yearEnd, designers: [], engineers: [], sharedPlatforms: [] });
w.LLM_FAMILIES = { families: {}, relations: {}, recheck: {
    "fam-holden-caprice": { status: "none" } },
  __serverAvailable: false };
w.LLM_FAMILIES.families["m-holden-caprice-vq"] = { status: "confirmed", sourceTitle: "Holden Caprice (VQ)", proposal: { hasMultipleGenerations: true, generations: [gen("VQ I", 1990, 1991), gen("VQ II", 1991, 1994)] } };
w.LLM_FAMILIES.relations["llm-m-holden-caprice-vq-vq-i|m-holden-commodore-vp|platform"] = { status: "confirmed", relType: "platform", famA: "m-holden-caprice-vq", famB: "m-holden-commodore-vp", genIdA: "llm-m-holden-caprice-vq-vq-i", genIdB: "m-holden-commodore-vp" };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies, S = w.LLM_FAMILIES, nodes = w.CarWeb.nodes, links = w.CarWeb.links;
const by = id => nodes.find(n => n.id === id);
const makes = () => nodes.filter(n => n.type === "make").length;
const mint = (text, origin) => LF.mintRelatedNode(nodes, links, text, null, origin);
const made = (text, origin) => { const id = mint(text, origin); return id && by(typeof id === "string" ? id : id.id); };
const g = nodes.find(n => n.id === "m-mercedes-benz-g-class");
let before = makes();
for (const notCar of ["CMF-B HS", "STLA Large", "GM VSS-S", "Hyundai-Kia M3", "Hyundai-Kia PB", "FIRE Evo"]) {
  t(`"${notCar}" is not a car`, !mint(notCar));
}
t("...and none made a make", makes() === before, makes() - before);
const guard = made("G 500 Guard", g.id);
t("a stem of the nameplate is that nameplate's make", guard && guard.make === "Mercedes-Benz" && guard.label === "G 500 Guard", guard && `${guard.make} / ${guard.label}`);
t("...its id as it was, so what is stored about it still finds it", guard && guard.id === "llm-related-g-500-guard", guard && guard.id);
const wagen = made("G-Wagen W462 ELBO", g.id);
t("...and so is a hyphenated one", wagen && wagen.make === "Mercedes-Benz", wagen && wagen.make);
const sun = made('Sunshine Special (automobile)|Lincoln "Sunshine Special"');
t("a link's text is the car's name", sun && sun.make === "Lincoln" && sun.label === "Sunshine Special", sun && `${sun.make} / ${sun.label}`);
const met = made("Testbrand (automobile)");
t("an article's title for a brand is named for the brand", met && met.make === "Testbrand" && met.label === "Testbrand", met && `${met.make} / ${met.label}`);
const bar = made("Bardo (car)");
t("a car filed by hand goes to its maker", bar && bar.make === "Iran Khodro" && bar.label === "Bardo", bar && `${bar.make} / ${bar.label}`);
const kom = made("T-98 Kombat");
t("...a maker the graph lacks is added", kom && kom.make === "Kombat Armouring" && kom.label === "T-98 Kombat", kom && `${kom.make} / ${kom.label}`);
const vw = made("VW Testcar");
t("a short name for a make is that make", vw && vw.make === "Volkswagen" && vw.label === "Testcar", vw && `${vw.make} / ${vw.label}`);
const found = LF.findMatchingNameplate(nodes, "VW Beetle", "nobody");
t("...and finds the car it already has", found && found.node && found.node.id === "m-volkswagen-beetle", found && found.node && found.node.id);
const real = made("Otherbrand Modelx");
t("a make the graph has never seen is still a make", real && real.make === "Otherbrand", real && real.make);
// The Caprice (VQ).
t("the Caprice (VQ) is no longer a nameplate of its own", S.families["m-holden-caprice-vq"].status === "none");
t("...it is the Caprice's first generation", by("m-holden-caprice-vq").retired && by("m-holden-caprice-vq").supersededBy === "m-holden-caprice");
t("...and what was found for its parts moves there", !!S.relations["m-holden-caprice|m-holden-commodore-vp|platform"], Object.keys(S.relations).join());
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
