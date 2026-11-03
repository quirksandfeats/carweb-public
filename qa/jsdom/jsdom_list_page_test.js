// A page that only lists other articles is not read as a car's article, and a code
// in brackets does not make a second car.
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
const CAR = "{{Infobox automobile\n| name = x\n}}\n";
const CLUBMAN_LIST = "'''Mini Clubman''' may refer to:\n\n*[[BL Mini Clubman]], the 1969–1980 British Leyland Mini Clubman \n*[[Morris Mini Clubman]], the Australian version of the BL Mini Clubman \n*[[Mini Clubman (2007)]], the BMW Mini Clubman 2007–2024\n\n{{sia|cars}}";
// As Wikipedia serves them: both older Clubmans are redirects into the Mini's article.
const PAGES = {
  "Mini Clubman": [CLUBMAN_LIST],
  "BL Mini Clubman": [CAR + "The Mini Clubman of 1969 and the Morris Mini Clubman.", "Mini"],
  "Morris Mini Clubman": [CAR + "The Mini Clubman of 1969 and the Morris Mini Clubman.", "Mini"],
  "Mini Clubman (2007)": [CAR + "The Mini Clubman, codes R55 and F54."],
  "Jaguar XF": ["'''Jaguar XF''' may refer to:\n* [[Jaguar XF (X250)]]\n* [[Jaguar XF (X260)]]\n{{sia|cars}}"],
  "Jaguar XF (X250)": [CAR + "The Jaguar XF X250."],
  "Jaguar XF (X260)": [CAR + "The Jaguar XF X260."],
  "Ford Prefect": ["'''Ford Prefect''' may refer to:\n*[[Ford Prefect (car)]], British cars\n*[[Ford Prefect (character)]], a character\n{{disambig}}"],
  "Ford Prefect (car)": [CAR + "The Ford Prefect."],
  "Ford Prefect (character)": ["{{Infobox character\n}}\nFord Prefect is a character."],
  "Honda Odyssey": ["'''Honda Odyssey''' may refer to:\n* [[Honda Odyssey (ATV)]]\n* [[Honda Odyssey (North America)]]\n{{set index article|cars}}"],
  "Honda Odyssey (ATV)": [CAR + "The Honda Odyssey ATV."],
  "Honda Odyssey (North America)": [CAR + "The Honda Odyssey minivan."],
  "Chevrolet Sonic": ["'''Chevrolet Sonic''' may refer to:\n* [[Chevrolet Sonic (crossover)]]\n* [[Chevrolet Sonic (2012)]]\n{{sia|cars}}"],
  "Chevrolet Sonic (crossover)": [CAR + "The Chevrolet Sonic crossover."],
  "Chevrolet Sonic (2012)": [CAR + "The Chevrolet Aveo, sold as the Chevrolet Sonic.", "Chevrolet Aveo (T300)"],
  "Fiat Talento": ["'''Fiat Talento''' may refer to:\n* [[Fiat Ducato]]\n* [[Renault Trafic]]\n{{set index article|cars}}"],
  "Fiat Ducato": [CAR + "The Fiat Ducato, sold as the Fiat Talento."],
  "Renault Trafic": [CAR + "The Renault Trafic, sold as the Fiat Talento."],
  "Kia Pride": ["The '''Kia Pride''' is a car.\n==Generations==\n{{Main|Ford Festiva}}\n* a line\n{{Set index article|cars}}"],
  "Ford Festiva": [CAR + "The Ford Festiva, sold as the Kia Pride."],
};
let modelAsked = 0;
w.fetch = async url => {
  if (!/wikipedia\.org/.test(String(url))) modelAsked++;
  const page = new URL(String(url), "http://x").searchParams.get("page");
  const hit = page && PAGES[page];
  if (!hit) return { ok: true, json: async () => ({ query: { search: [] } }) };
  return { ok: true, json: async () => ({ parse: { title: hit[1] || page, wikitext: { "*": hit[0] } } }) };
};
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const CLUBMAN = "llm-related-mini-clubman", F54 = "llm-related-mini-clubman-f54", MORRIS = "llm-related-morris-mini-clubman";
const f54Rel = "llm-m-bmw-x2-f39|llm-related-mini-clubman-f54|platform";
w.LLM_FAMILIES = { settings: { reviewedV: 7 }, rejectedRelations: {}, renames: {}, userCars: {},
  wpLinks: { [CLUBMAN]: "Mini Clubman", [MORRIS]: "Mini" }, mintedFacts: { [CLUBMAN]: { year: 2007, end: 2024 }, [MORRIS]: { year: 1959, end: 2000 } },
  relations: {
    [f54Rel]: { status: "confirmed", famA: "m-bmw-x2", famB: F54, relType: "platform", genIdA: "llm-m-bmw-x2-f39", genIdB: F54, codeA: "X2 F39", codeB: "Clubman (F54)" },
    "llm-llm-related-mini-clubman-bmw-mini-clubman|llm-related-morris-mini-clubman|platform": { status: "confirmed", famA: CLUBMAN, famB: MORRIS, relType: "platform", genIdA: "llm-llm-related-mini-clubman-bmw-mini-clubman", genIdB: MORRIS },
  },
  families: { [CLUBMAN]: { status: "confirmed", checkedAt: "2026-10-13T00:00:00Z", sourceTitle: "Mini Clubman", proposal: { hasMultipleGenerations: true, generations: [
    { code: "BL Mini Clubman", yearStart: 1969, yearEnd: 1980, sharedPlatforms: ["Morris Mini Clubman"] },
    { code: "BMW Mini Clubman", yearStart: 2007, yearEnd: 2024, sharedPlatforms: [] }] } },
    [MORRIS]: { status: "same-article", sameAs: "m-austin-mini", sourceTitle: "Mini" } },
  recheck: { "fam-holden-caprice": { status: "none" }, [CLUBMAN]: { status: "none", sourceTitle: "Mini Clubman" } },
  engineScans: { [F54]: { status: "no-article", engines: [] } },
  aliases: { "llm-m-austin-mini-mini-1275-gt": { names: ["Morris Mini Clubman (Australia)"] } },
  __serverAvailable: false };
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]))
  if (f !== "d3.min.js" && f !== "data.js" && !/llm_families_data/.test(f)) ev(f);
w.CarWeb.boot();
const LF = w.LlmFamilies, N = w.CARDATA.nodes;
const by = id => N.find(n => n.id === id && !n.retired);
const id = v => typeof v === "string" ? v : v.id;
const linked = (a, b) => w.CARDATA.links.some(l => !l.retired && l.type === "platform" && [id(l.source), id(l.target)].sort().join() === [a, b].sort().join());
(async () => {
  t("{{sia}} marks a list page", LF.isListOfArticles(CLUBMAN_LIST));
  t("{{disambig}} marks a list page", LF.isListOfArticles(PAGES["Ford Prefect"][0]));
  t("a set index with sections is an article", !LF.isListOfArticles(PAGES["Kia Pride"][0]));
  t("a car's article is not a list", !LF.isListOfArticles(CAR + "The Mini Clubman may refer to nothing."));
  t("the Clubman that read the list is gone", !by(CLUBMAN) && !by("llm-llm-related-mini-clubman-bl-mini-clubman") && !by("llm-llm-related-mini-clubman-bmw-mini-clubman"));
  t("so are the F54 and Morris copies", !by(F54) && !by(MORRIS));
  t("the real Clubman stays", by("m-mini-clubman-2007") && by("m-mini-clubman-2007").wp === "Mini Clubman (2007)");
  t("the F54's partner moved to it", !!w.LLM_FAMILIES.relations["llm-m-bmw-x2-f39|m-mini-clubman-2007|platform"] && !w.LLM_FAMILIES.relations[f54Rel]);
  t("the 1969 Clubman is named on the Mini's generation", LF.aliasesFor("llm-m-austin-mini-mini-1275-gt").includes("Mini Clubman"));

  modelAsked = 0;
  const stub = { id: "llm-related-test-clubman", type: "model", make: "Mini", label: "Clubman", wp: "Mini Clubman" };
  const owned = await LF.settleListPage(stub, N);
  t("a name covering other cars' pages has nothing to read", owned && owned.pages.length === 0);
  t("and with two cars listed its link stays", stub.wp === "Mini Clubman");
  const scan = await LF.runCheck(stub, null, null, undefined, N);
  t("the check is not split and asks no model", scan.clean.notACar && !scan.clean.generations.length && modelAsked === 0, scan.clean.notACar);
  const free = { id: "x-prefect", type: "model", make: "Ford", label: "Prefect", wp: "Ford Prefect" };
  const others = N.filter(n => n.wp !== "Ford Prefect (car)");
  t("the one car page listed becomes the article", (await LF.settleListPage(free, others)) === null && free.wp === "Ford Prefect (car)");
  const moped = { id: "x-ody", type: "model", make: "Honda", label: "Odyssey", wp: "Honda Odyssey" };
  t("an ATV's page is no car's article", (await LF.settleListPage(moped, [{ id: "o", type: "model", wp: "Honda Odyssey (North America)" }])).pages.length === 0 && moped.wp === "Honda Odyssey (North America)", moped.wp);
  const sonic = { id: "x-sonic", type: "model", make: "Chevrolet", label: "Sonic", wp: "Chevrolet Sonic" };
  t("a page listed under the car's name is its own, whatever it is served as", (await LF.settleListPage(sonic, [{ id: "c", type: "model", wp: "Chevrolet Sonic (crossover)" }])) === null && sonic.wp === "Chevrolet Aveo (T300)", sonic.wp);
  const spans = await LF.settleListPage({ id: "x-xf", type: "family", make: "Jaguar", label: "XF", wp: "Jaguar XF" }, []);
  t("several free pages are all read", spans && spans.pages.map(p => p.title).join() === "Jaguar XF (X250),Jaguar XF (X260)");
  const talento = await LF.settleListPage({ id: "x-tal", type: "family", make: "Fiat", label: "Talento", wp: "Fiat Talento" }, []);
  t("a nameplate does not read a page without its name", talento && !talento.pages.length);
  const taken = await LF.settleListPage({ id: "x-xf2", type: "family", make: "Jaguar", label: "XF", wp: "Jaguar XF" }, [{ id: "o", type: "model", wp: "Jaguar XF (X250)" }]);
  t("a nameplate reads its pages even when another car links one", taken && taken.pages.length === 2);
  t("a set index with sections is left alone", (await LF.settleListPage({ id: "x-pride", type: "model", make: "Kia", label: "Pride", wp: "Kia Pride" }, [])) === null);
  t("a lookup takes the one listed page", (await LF.findWikipediaTitleFor("Ford", "Prefect", { strict: true })) === "Ford Prefect (car)");
  t("and keeps a list of several, for the check to settle", (await LF.findWikipediaTitleFor("Mini", "Clubman", { strict: true })) === "Mini Clubman");
  t("no model was asked", modelAsked === 0);

  const nodes = [{ id: "a", type: "model", make: "Mini", label: "Clubman (2007)", year: 2007, end: 2024 },
    { id: "b", type: "family", make: "Toyota", label: "Hilux", year: 1968 },
    { id: "c", type: "model", make: "Ford", label: "Escort", year: 1968, end: 2004 },
    { id: "d", type: "model", make: "Ford", label: "Fairlane", year: 1955, end: 1970 }];
  const same = (text, y, e) => (LF.sameCarOutsideBrackets(nodes, text, { year: y, end: e }, "origin") || {}).id;
  t("a code in brackets is the car with a year in brackets", same("Mini Clubman (F54)", 2018, 2023) === "a");
  t("and the car of that plain name", same("Toyota Hilux (N30)", 1980, 1985) === "b");
  t("the bare name reaches a car with only a year in brackets", same("Mini Clubman", 2018, 2023) === "a");
  t("not across decades", !same("Mini Clubman", 1969, 1980));
  t("a place in brackets is another car", !same("Ford Escort (Europe)", 1980, 1985));
  t("a code too far from these years is another car", !same("Ford Fairlane (NL)", 1995, 1999));
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("FAIL threw", e); process.exit(1); });
