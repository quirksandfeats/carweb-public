// A car with no end year is measured at its first year. A partner that ended that
// year ties with the one that carried on, and the car goes with the one that carried on.
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
w.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "{}" });
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
const store = JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8"));
store.settings.reviewedV = 13;
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") w.LLM_FAMILIES = Object.assign({}, store, { __serverAvailable: false });
  ev(f);
}
w.CarWeb.boot();
const LF = w.LlmFamilies;
const links = w.CARDATA.links;
const idOf = v => (typeof v === "string" ? v : v.id);
const linked = (a, b) => links.some(l => l.type === "platform" && !l.retired && [idOf(l.source), idOf(l.target)].sort().join("|") === [a, b].sort().join("|"));

// ---------- the rule ----------
const car = (id, year, end) => ({ id, year, end: end === undefined ? null : end });
const pick = (o, ...c) => (LF.successorGeneration(o, c) || {}).id;
const old = car("old", 2004, 2015), next = car("next", 2015), older = car("older", 1990, 2003);
t("no end year, handover in its first year: the one that carried on", pick(car("o", 2015), old, next) === "next");
t("the order of the candidates does not matter", pick(car("o", 2015), next, old) === "next");
t("a partner with a stated later end carried on too", pick(car("o", 2015), old, car("next", 2015, 2023)) === "next");
t("a partner begun before the handover carried on too", pick(car("o", 2015), old, car("next", 2012, 2020)) === "next");
t("no one carried on: the one that ended that year", pick(car("o", 2015), old) === "old");
t("a later generation only is no reason to leave the one that ended that year", pick(car("o", 2015), old, car("later", 2016)) === "old");

// What the rule leaves alone.
t("a stated one-year car still ties to the earlier", pick(car("o", 2015, 2015), old, next) === "old");
t("a stated end still takes the overlap", pick(car("o", 2015, 2020), old, next) === "next");
t("a stated end in the earlier one's years takes the earlier", pick(car("o", 2006, 2012), old, next) === "old");
t("two that both carried on: the earlier", pick(car("o", 2013), car("a", 2010, 2016), car("b", 2012, 2018)) === "a");
t("none built then: the nearest earlier", pick(car("o", 2010), older, car("c", 2012)) === "older");
t("nothing earlier: the nearest", pick(car("o", 1980), older, next) === "older");
t("no start year: the earliest", pick(car("o", null), old, next) === "old");
t("nothing to choose from", pick(car("o", 2015)) === undefined);
t("it does not choose itself", pick(next, next, old) === "old");

// ---------- on the shipped store ----------
const MOVED = [
  ["llm-m-toyota-fortuner-second-generation-an150-an160", "llm-m-toyota-hilux-an110-an120-an130", "llm-m-toyota-hilux-an10-an20-an30"],
  ["llm-fam-honda-accord-eleventh-generation", "llm-m-honda-inspire-seventh-generation-cy", "llm-m-honda-inspire-sixth-generation-cv4-cv6"],
  ["llm-m-volkswagen-tayron-typ-dn", "llm-m-volkswagen-tiguan-ct1", "llm-m-volkswagen-tiguan-ad1-ax1"],
];
const has = id => w.CARDATA.nodes.some(n => n.id === id && !n.retired);
for (const [a, right, wrong] of MOVED) {
  t(`${a} and its two partners are on the graph`, has(a) && has(right) && has(wrong));
  t(`${a} is on ${right}`, linked(a, right));
  t(`${a} is off ${wrong}`, !linked(a, wrong));
}

// ---------- what the articles say against the years ----------
t("the Harrier stays on the D8's Evoque", linked("llm-m-land-rover-range-rover-evoque-l538", "m-tata-harrier"));
t("and not on the L551", !linked("llm-m-land-rover-range-rover-evoque-l551", "m-tata-harrier"));
t("the Tara stays on the PF1's 208", linked("llm-m-peugeot-208-a9", "m-ikco-tara"));
t("and not on the P21", !linked("llm-m-peugeot-208-p21", "m-ikco-tara"));
t("the second Rich keeps the D22", linked("llm-m-dongfeng-rich-second-generation", "llm-m-nissan-navara-d22"));
t("the C3 Aircross A88 keeps the third C3", linked("llm-m-citroen-c3-aircross-a88", "llm-m-citroen-c3-sx-sy"));
t("the Smart Car cars are on the fourth C3", linked("llm-m-citroen-c3-cc21", "m-citroen-basalt") && linked("llm-m-citroen-c3-cc21", "llm-related-opel-frontera"));
t("and off the third", !linked("llm-m-citroen-c3-sx-sy", "m-citroen-basalt") && !linked("llm-m-citroen-c3-sx-sy", "llm-related-opel-frontera"));

// ---------- what the review changes, and that it changes it once ----------
const saved = w.LLM_FAMILIES;
t("the review ran", saved.settings.reviewedV >= 14, saved.settings.reviewedV);
t("the pins are the articles' now", /D8 platform/.test(saved.relations["llm-m-land-rover-range-rover-evoque-l538|m-tata-harrier|platform"].reason));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
