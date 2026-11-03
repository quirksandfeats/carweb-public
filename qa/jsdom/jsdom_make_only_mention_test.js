// A mention that names only a maker makes no car, and links the review declined stay gone.
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
const V37 = "llm-m-nissan-skyline-nissan-skyline-v37|m-nissan-gt-r-r35|platform";
const FORD = { matchId: "mk-ford", makeGuessWords: 1, reason: "the Ford brand" };
w.LLM_FAMILIES = { settings: { reviewedV: 5 }, rejectedRelations: {}, renames: {}, userCars: {}, wpLinks: {}, mintedFacts: {},
  relations: { [V37]: { status: "confirmed", famA: "m-nissan-gt-r-r35", famB: "m-nissan-skyline", relType: "platform", genIdA: "m-nissan-gt-r-r35", genIdB: "llm-m-nissan-skyline-nissan-skyline-v37" } },
  families: { "m-lincoln-continental": { status: "confirmed", checkedAt: "2026-10-01T00:00:00Z", sourceTitle: "Lincoln Continental", proposal: { hasMultipleGenerations: true, generations: [
    { code: "Fifth generation", yearStart: 1970, yearEnd: 1979, sharedPlatforms: ["Full-size Ford", "Ford Maverick Grabber", "Concept EQG"], makeVariantMatches: { "Full-size Ford": FORD } },
    { code: "Sixth generation", yearStart: 1980, yearEnd: 1981, sharedPlatforms: [] } ] } } },
  recheck: { "fam-holden-caprice": { status: "none" } }, __serverAvailable: false };
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]))
  if (f !== "d3.min.js" && f !== "data.js" && !/llm_families_data/.test(f)) ev(f);
w.CarWeb.boot();
const by = id => w.CARDATA.nodes.find(n => n.id === id);
const id = v => typeof v === "string" ? v : v.id;
const linked = (a, b) => w.CARDATA.links.some(l => !l.retired && l.type === "platform" && [id(l.source), id(l.target)].sort().join() === [a, b].sort().join());
t("a mention of only a maker makes no car", !by("llm-related-ford-ford"));
t("a Ford with a real name is still a car", !!by("llm-related-ford-maverick-grabber"));
t("the GT-R is not on the V37's platform", !linked("m-nissan-gt-r-r35", "llm-m-nissan-skyline-nissan-skyline-v37"));
t("nor on the Skyline's", !linked("m-nissan-gt-r-r35", "m-nissan-skyline"));
t("the Escort named as the Gol's rival makes no car", !by("llm-related-ford-escort"));
const { hatnotePageIsAboutCars: about } = w.LlmFamilies;
t("a car's own page is read", about("{{Infobox automobile\n| name = Nissan Skyline GT-R", "Nissan Skyline GT-R", "Nissan"));
t("so is a platform's", about("{{Infobox automobile platform\n| name = MQB", "MQB platform", "Volkswagen"));
t("and a page under the car's make with no infobox", about("The Beetle was built in Puebla.", "Volkswagen Beetle in Mexico", "Volkswagen"));
t("an engine's page is not", !about("{{Infobox automobile engine\n| name = VR", "Nissan VR engine", "Nissan"));
t("nor a list", !about("{{Infobox automobile", "List of Nürburgring Nordschleife lap times", "Nissan"));
t("nor a drive system's", !about("ATTESA is a four-wheel drive system.", "ATTESA E-TS", "Nissan"));
t("nor a championship's", !about("{{Infobox motorsport championship\n| name = Clio Cup", "Renault Clio Cup", "Renault"));
t("nor one that sits under another make's name with a company box", !about("{{Infobox company\n| name = Neckar", "Neckar (car)", "Fiat"));
t("a car filed under a wrong make moves to the right one", by("llm-related-concept-eqg").make === "Mercedes-Benz", by("llm-related-concept-eqg").make);
process.exit(fails ? 1 : 0);
