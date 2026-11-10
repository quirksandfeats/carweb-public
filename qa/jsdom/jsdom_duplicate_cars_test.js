// A single car that is a generation shown twice goes into the generation (10 Nov 2026).
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const check = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = fakeCtx;
window.requestAnimationFrame = () => 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "{}" });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
const shipped = JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") window.LLM_FAMILIES = Object.assign({}, shipped, { __serverAvailable: false });
  ev(f);
}
window.CarWeb.boot();
const nodes = window.CARDATA.nodes, links = window.CARDATA.links;
const byId = new Map(nodes.map(n => [n.id, n]));
const idOf = v => typeof v === "string" ? v : v.id;
const LF = window.LlmFamilies;
check("a folded car keeps its name among the generation's: Toyota Zenix", LF.aliasesFor("llm-m-toyota-innova-ag10").some(x => /Zenix/.test(x)), LF.aliasesFor("llm-m-toyota-innova-ag10").join(", "));
check("the list is loaded", Object.keys(window.DUPLICATE_CARS || {}).length >= 30);
const veloz = byId.get("llm-related-toyota-veloz");
check("the Toyota Veloz goes into the Avanza W100", veloz && veloz.retired && veloz.supersededBy === "llm-m-toyota-avanza-w100");
check("its name stays as another name of the generation, once", LF.aliasesFor("llm-m-toyota-avanza-w100").filter(x => x === "Toyota Veloz").length === 1, LF.aliasesFor("llm-m-toyota-avanza-w100").join(", "));
check("a folded name given already with a market is not added again: Hyundai Marcia", LF.aliasesFor("llm-llm-related-hyundai-sonata-y3").filter(x => /Marcia/.test(x)).length === 1, LF.aliasesFor("llm-llm-related-hyundai-sonata-y3").join(", "));
check("no drawn link is left on a folded car", !links.some(l => !l.retired && !l.mirror && Object.keys(window.DUPLICATE_CARS).some(id => idOf(l.source) === id || idOf(l.target) === id)));
check("two show cars of one year stay two cars: the Pontiac Banshee XP-798", !byId.get("llm-m-pontiac-banshee-xp-798").retired);
check("so does the 1940 Chrysler Thunderbolt", !byId.get("llm-related-chrysler-thunderbolt").retired);
check("a car with a code of another generation is not folded: the Audi S3 Mk1", !byId.get("llm-related-audi-s3-mk1").retired);
const rx7 = byId.get("m-mazda-rx-7-fd");
check("a car with connections of its own goes in too, with them: the Mazda RX-7 (FD)", rx7.retired && rx7.supersededBy === "llm-m-mazda-rx-7-fb-fd" &&
  links.some(l => !l.retired && l.type === "engineered" && [idOf(l.source), idOf(l.target)].includes("llm-m-mazda-rx-7-fb-fd")));
// A nameplate shown twice: the Ford Falcon (Australia) beside the Falcon of the build data.
const falcon = byId.get("fam-ford-falcon"), aus = byId.get("m-ford-falcon-australia");
check("the Australian Falcon is shown once", aus.retired && aus.supersededBy === "fam-ford-falcon");
check("the Falcon kept takes the article of the Australian car", falcon.wp === "Ford Falcon (Australia)", falcon.wp);
check("its generations are the ones with articles of their own", (falcon.generations || []).filter(id => !byId.get(id).retired).length === 24);
check("each generation of the other went to its code's: XD", byId.get("llm-m-ford-falcon-australia-xd").supersededBy === "m-ford-falcon-xd");
check("a code the kept nameplate lacks goes to the car of its title: EL", byId.get("llm-m-ford-falcon-australia-el").supersededBy === "m-ford-falcon-el");
check("no Falcon generation is shown twice", nodes.filter(n => !n.retired && n.make === "Ford" && /^Falcon .*\bXD\b/.test(n.label)).length <= 1,
  nodes.filter(n => !n.retired && n.make === "Ford" && /^Falcon .*\bXD\b/.test(n.label)).map(n => n.label).join(", "));
// A car standing for a list of one name, in the very years of one listed car.
const topo = byId.get("llm-related-fiat-topolino");
check("the \"Fiat Topolino\" stand-in is the Fiat 500 \"Topolino\" twice: one Topolino", topo.retired && topo.supersededBy === "m-fiat-500-22topolino-22");
const linkedTo = (a, b, type) => links.some(l => !l.retired && l.type === type && [idOf(l.source), idOf(l.target)].sort().join("|") === [a, b].sort().join("|"));
check("a connection goes to the listed car its years meet: the XD Falcon's to the Fairlane (Australia)",
  linkedTo("m-ford-fairlane-australia", "llm-m-ford-falcon-australia-xd", "platform") || linkedTo("m-ford-fairlane-australia", "m-ford-falcon-xd", "platform"));
check("the rest to the twin: the Ranchero's to the Fairlane (Americas)", links.some(l => !l.retired && l.type === "platform" &&
  [idOf(l.source), idOf(l.target)].some(id => id === "m-ford-fairlane-americas" || (byId.get(id) || {}).familyOf === "m-ford-fairlane-americas") &&
  [idOf(l.source), idOf(l.target)].some(id => /ranchero/.test(id))));
// Trims, versions and other names of one generation (ruling 1, 8 Nov 2026).
const into = id => (byId.get(id) || {}).supersededBy;
check("a name a generation's infobox gives: the Toyota Echo is the Yaris XP10", into("llm-related-toyota-echo") === "llm-m-toyota-yaris-xp10");
check("a trim goes to the generation its section dates: the Rogue Plug-in Hybrid (2025) to the third Rogue",
  into("llm-related-nissan-rogue-plug-in-hybrid") === "llm-m-nissan-rogue-third-generation");
check("a trim whose years are the nameplate's goes nowhere: the Corolla Axio", !byId.get("llm-related-toyota-corolla-axio").retired);
check("a name in the nameplate's own name is no one generation's: the Porsche Cayman", !byId.get("llm-related-porsche-cayman").retired);
check("a folded car's end is not the generation's: the DS 3 is still built", byId.get("llm-m-ds-3-second-generation").end == null);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
