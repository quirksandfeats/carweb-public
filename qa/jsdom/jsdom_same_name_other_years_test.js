// A generation and a car of the same name in other years are two cars. findDuplicateGeneration
// retired the real car on the name alone, at every load, so no re-scan could bring it back.
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
const DATA = window.CARDATA;
const idOf = v => (typeof v === "string" ? v : v.id);
const N = id => DATA.nodes.find(n => n.id === id);
const named = (id, type = "platform") => DATA.links.filter(l => !l.retired && !l.mirror && l.type === type && (idOf(l.source) === id || idOf(l.target) === id))
  .map(l => idOf(l.source) === id ? idOf(l.target) : idOf(l.source));

check("the Fiat 500L is back, and the 1968 500 L stays a generation", !N("m-fiat-500l").retired && !N("llm-fam-fiat-500-500-l").retired);
check("the 1968 500 L has not its article", N("llm-fam-fiat-500-500-l").wp !== "Fiat 500L");
check("the Tipo sits beside the 500L", named("m-fiat-tipo-2015").includes("m-fiat-500l") && !named("m-fiat-tipo-2015").includes("llm-fam-fiat-500-500-l"));
check("the Ford Torino is back", !N("m-ford-torino").retired);
check("the Italian Anglia Torino has not the American car's links", !named("llm-m-ford-anglia-torino").some(id => /montego|ranchero|cougar/.test(id)));
check("the Torino has them", named("m-ford-torino").some(id => /montego/.test(id)));
check("the 300M is back, on its own article", !N("m-chrysler-300m").retired && N("m-chrysler-300m").wp === "Chrysler 300M");
check("the 1966 proposal is not the 300M's article", N("llm-llm-related-chrysler-300l-300m").wp !== "Chrysler 300M");
check("the 300C is the Chrysler 300, not the 1957 car", N("m-chrysler-300c").supersededBy === "llm-related-chrysler-300");
check("the 300M hands over to the Chrysler 300", named("m-chrysler-300m", "succession").includes("llm-llm-related-chrysler-300-first-generation"));
check("the letter series keeps its own 300C", !N("llm-llm-related-chrysler-300l-300c").retired);
const hilux = N("m-toyota-hilux").generations || [];
check("the Hilux Dakar is not a Hilux generation", !hilux.some(id => /dakar/.test(id)) && !N("llm-m-toyota-hilux-toyota-hilux-dakar"));
const follows = DATA.links.some(l => !l.retired && l.type === "gensucc" && idOf(l.source) === "llm-m-toyota-hilux-an10-an20-an30" && idOf(l.target) === "llm-m-toyota-hilux-an110-an120-an130");
check("the Hilux runs from AN10 to AN110", follows);
check("a car sharing its years with a generation of that name still folds: the R107", !!N("m-mercedes-benz-r107") ? N("m-mercedes-benz-r107").retired === true || !!N("m-mercedes-benz-r107").familyOf : true);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
