// A re-scan that lands on a page listing other articles leaves a nameplate's generations alone.
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
const LIST = "'''Mini Clubman''' may refer to:\n*[[BL Mini Clubman]]\n*[[Morris Mini Clubman]]\n{{sia|cars}}";
let modelAsked = 0;
w.fetch = async (url, init) => {
  const u = String(url);
  if (!/wikipedia\.org/.test(u)) {
    if (/completions|chat|llama/.test(u)) modelAsked++;
    return { ok: true, json: async () => ({}), text: async () => "{}" };
  }
  const page = new URL(u).searchParams.get("page");
  if (page === "Mini Clubman") return { ok: true, json: async () => ({ parse: { title: page, wikitext: { "*": LIST } } }) };
  if (page) return { ok: true, json: async () => ({ parse: { title: "Mini", wikitext: { "*": "{{Infobox automobile\n}}\nThe Mini Clubman." } } }) };
  return { ok: true, json: async () => ({ query: { search: [] } }) };
};
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const FAM = "llm-related-mini-test";
w.LLM_FAMILIES = { settings: { reviewedV: 8 }, rejectedRelations: {}, renames: {}, userCars: {}, wpLinks: {}, mintedFacts: {}, relations: {}, families: {}, recheck: {}, __serverAvailable: true };
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]))
  if (f !== "d3.min.js" && f !== "data.js" && !/llm_families_data/.test(f)) ev(f);
w.CarWeb.boot();
const LF = w.LlmFamilies, N = w.CARDATA.nodes, L = w.CARDATA.links;
(async () => {
  const fam = { id: FAM, type: "family", make: "Mini", label: "Clubman", wp: "Mini Clubman", generations: ["g1", "g2"] };
  const gens = [{ id: "g1", type: "model", make: "Mini", label: "Clubman One", familyOf: FAM, year: 1969, end: 1980 },
                { id: "g2", type: "model", make: "Mini", label: "Clubman Two", familyOf: FAM, year: 2007, end: 2024 }];
  N.push(fam, ...gens);
  const entry = await LF.forceRecheckFamily(fam, gens, N, L, { keepRejections: true });
  t("the re-scan closes with nothing to review", entry.status === "none", entry.status);
  t("it says why", entry.proposal && entry.proposal.notACar === "an index of other articles", entry.proposal && entry.proposal.notACar);
  t("no generation is up for retiring", !gens.some(g => g.retired) && !entry.generationDiff);
  t("no model was asked", modelAsked === 0);
  // Its years inside those of a generation that stays: from an article, this one is retired.
  const inner = { id: "g3", type: "model", make: "Mini", label: "Clubman Three", familyOf: FAM, year: 1970, end: 1975 };
  const read = fromIndexPage => LF.decideRecheck(fam, [gens[0], inner], { sections: [], sourceTitle: "Mini Clubman",
    proposal: { generations: [{ code: "Clubman One", yearStart: 1969, yearEnd: 1980 }], fromIndexPage } }, N).retire.map(g => g.id).join();
  t("from an article, a generation the list leaves out is retired", read(false) === "g3", read(false));
  t("a list read off an index page retires nothing", read(true) === "", read(true));
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("FAIL threw", e); process.exit(1); });
