// Fixes of 10 Nov 2026: a car's own new article (Ford Contour), a bare nameplate
// beside its first generation (Nissan Leaf), a model match under another maker's
// name (Venucia e30), and a generation read through "see also".
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
// The Contour's readings off the first Mondeo's article, as they stood before the rule.
shipped.families = Object.assign({}, shipped.families, { "llm-related-ford-contour": Object.assign({}, shipped.families["llm-related-ford-contour"] || {
  status: "confirmed", proposal: { hasMultipleGenerations: true, generations: [{ code: "Mk I / Mk II", yearStart: 1994, yearEnd: 2000 }, { code: "North American", yearStart: 1994, yearEnd: 2000 }] } },
  { sourceTitle: "Ford Mondeo (first generation)" }) });
shipped.wpRedirects = Object.assign({}, shipped.wpRedirects, { "Ford Contour": "Ford Mondeo (first generation)" });
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") window.LLM_FAMILIES = Object.assign({}, shipped, { __serverAvailable: false });
  ev(f);
}
window.CarWeb.boot();
const nodes = window.CARDATA.nodes, links = window.CARDATA.links;
const byId = new Map(nodes.map(n => [n.id, n]));
const live = id => byId.get(id) && !byId.get(id).retired;
const idOf = v => typeof v === "string" ? v : v.id;
const linked = (a, b, type) => links.some(l => !l.retired && l.type === type &&
  ((idOf(l.source) === a && idOf(l.target) === b) || (idOf(l.source) === b && idOf(l.target) === a)));
const LF = window.LlmFamilies;

// Ford Contour: its own article now, nothing read off the Mondeo's kept.
const contour = byId.get("llm-related-ford-contour");
check("the Contour links its own article", contour && contour.wp === "Ford Contour", contour && contour.wp);
check("the Mondeo's generations are no longer the Contour's", !nodes.some(n => n.familyOf === "llm-related-ford-contour" && !n.retired));
check("the old redirect is forgotten", !(window.LLM_FAMILIES.wpRedirects || {})["Ford Contour"]);

// Nissan Leaf: three generations, the first being the first generation's article.
const leafGens = (byId.get("fam-nissan-leaf").generations || []).filter(live);
check("the Leaf shows three generations", leafGens.length === 3, leafGens.map(id => byId.get(id).label).join(", "));
check("its first is the first generation's own article", leafGens.includes("m-nissan-leaf-first-generation"));
check("the bare Leaf is folded into it", byId.get("m-nissan-leaf").retired && !nodes.some(n => !n.retired && /^Leaf ZE0/.test(n.label)));

// Venucia e30: Dongfeng-Nissan's Leaf, no Zotye.
check("the first Leaf is not on the Zotye E30's platform", !linked("m-nissan-leaf-first-generation", "m-zotye-e30", "platform"));
check("nor the Kwid", !linked("llm-m-renault-kwid-bw", "m-zotye-e30", "platform"));
const venucia = nodes.find(n => !n.retired && n.make === "Venucia" && /e30/i.test(n.label));
check("the Venucia e30 is a car of its own on the first Leaf's platform", !!venucia && linked("m-nissan-leaf-first-generation", venucia.id, "platform"), venucia && venucia.id);
check("a badge of another maker its article names stays (Chevrolet Nexia, the Daewoo Nexia)",
  links.some(l => !l.retired && l.type === "platform" && [idOf(l.source), idOf(l.target)].includes("llm-related-daewoo-nexia")));

// "{{see also|...}}" opening a generation's section names its own article.
const sec = "{{see also|Lincoln Continental Mark VI}}\nThe Mark VI was downsized for 1980.";
check("a see-also naming the generation's code is its article",
  LF.engineArticleFor({ id: "g", label: "Mark series Mark VI", make: "Lincoln", familyOf: "f", wp: "Lincoln Mark series" },
    { id: "f", label: "Mark series", make: "Lincoln", wp: "Lincoln Mark series" },
    "== Fifth generation (Mark VI; 1980–1983) ==\n" + sec + "\n== Sixth generation (Mark VII) ==\nx", "Lincoln Mark series") === "Lincoln Continental Mark VI");
check("a see-also naming a relative is not",
  LF.engineArticleFor({ id: "g", label: "Mark series Mark VI", make: "Lincoln", familyOf: "f", wp: "Lincoln Mark series" },
    { id: "f", label: "Mark series", make: "Lincoln", wp: "Lincoln Mark series" },
    "== Fifth generation (Mark VI; 1980–1983) ==\n{{see also|Ford Thunderbird (eighth generation)}}\nx", "Lincoln Mark series") !== "Ford Thunderbird (eighth generation)");
const due = LF.engineReadsDue(nodes).map(n => n.id);
check("a generation's empty read of its nameplate's page is due again", due.includes("m-lincoln-mark-series"));
check("a car with engines read by the last reader is not", !due.includes("fam-ford-falcon"));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
