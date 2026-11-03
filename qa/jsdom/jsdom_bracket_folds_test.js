// A name with a code in brackets, beside the car it names, folds into that car on the shipped store.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
function boot(store) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window: w } = dom;
  w.HTMLCanvasElement.prototype.getContext = fakeCtx;
  w.requestAnimationFrame = () => 1;
  w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  w.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "{}" });
  w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = w; global.document = w.document;
  const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
    if (/llm_families_data/.test(f)) continue;
    if (f === "llm_families.js") w.LLM_FAMILIES = Object.assign({}, store, { __serverAvailable: false });
    ev(f);
  }
  w.CarWeb.boot();
  return w;
}
const store = JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8"));
store.settings.reviewedV = 8;
const w = boot(store);
const nodes = w.CARDATA.nodes, links = w.CARDATA.links;
const alive = id => { const n = nodes.find(x => x.id === id); return !!n && !n.retired; };
const idOf = v => (typeof v === "string" ? v : v.id);
const linked = (a, b, type) => links.some(l => l.type === type && [idOf(l.source), idOf(l.target)].sort().join("|") === [a, b].sort().join("|"));
for (const id of ["llm-related-toyota-hilux-n30", "llm-related-audi-a4-b5", "m-pontiac-gto-2004", "llm-related-nissan-march-third-generation"])
  t(id + " is folded", !alive(id));
t("its link moves to the generation", links.some(l => l.type === "platform" && l.reboundFrom === "llm-related-nissan-march-second-generation" && [idOf(l.source), idOf(l.target)].includes("llm-m-nissan-micra-k11")));
t("the 1909 Lancia Beta stays apart from the 1972 one", alive("m-lancia-beta-1909") && alive("m-lancia-beta"));
for (const id of ["llm-related-chrysler-300-1979", "llm-related-ford-futura-venezuela", "llm-related-chevrolet-ss-south-africa"])
  t(id + " is a different car, and stays", alive(id));
t("the Thunderbird that read the Mustang keeps no Mustang generations",
  !alive("llm-llm-related-ford-thunderbird-83-88-ford-mustang-third-generation") && !alive("llm-related-ford-thunderbird-83-88"));
t("the Arkana has one name", nodes.find(n => n.id === "llm-related-renault-arkana-cmf-b").label === "Arkana" && !alive("llm-related-renault-arkana"));
t("the EXA is not on the Terrano", !linked("llm-m-nissan-exa-n13", "llm-related-nissan-terrano", "platform"));
const out = Object.assign({}, w.LLM_FAMILIES); delete out.__serverAvailable;
t("the F54's partners are on the F54", Object.values(out.relations).some(e => e.reason === "the Mini Clubman (F54) is the second generation of this car" && [e.genIdA, e.genIdB].includes("llm-m-mini-clubman-2007-f54")));
t("nothing folds a car that has its own generations left over", nodes.every(n => n.retired || !n.familyOf || nodes.some(p => p.id === n.familyOf && !p.retired)));
const live = () => nodes.filter(n => !n.retired).length;
const first = live();
const again = boot(out);
t("a second load changes nothing", again.CARDATA.nodes.filter(n => !n.retired).length === first);
console.log(fails ? fails + " failed" : "all passed");
process.exit(fails ? 1 : 0);
