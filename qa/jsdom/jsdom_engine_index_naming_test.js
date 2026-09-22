// Real user reports:
//  - "The Opel Omega B (which in the knowledge graph is incorrectly labeled as
//    the Opel Omega Omega B) has the correctly listed engines, but once again
//    has no link to the actual engines" -- its infobox links bare codes
//    ([[X20SE]]) and code-displayed titles ([[GM Ecotec Diesel (1997)|X20DTH]]).
//  - Engine names flipping on every load: "List of Daihatsu" -> "JB-DET" ->
//    "List of Daihatsu" -> ..., and names like "Four-cylinder" and
//    "3 cylinder", which no engine is called.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app"), CACHE = path.resolve(__dirname, "..", "wiki_cache");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
const fakeCtx = () => new Proxy({ measureText: () => ({ width: 10 }) },
  { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });
const OMEGA = fs.readFileSync(path.join(CACHE, "Opel_Omega.wikitext"), "utf-8");

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1; window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = (url) => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m && decodeURIComponent(m[1]).replace(/_/g, " ") === "Opel Omega")
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title: "Opel Omega", wikitext: { "*": OMEGA } } }) });
  if (m) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;

const now = new Date().toISOString();
function seed(D) {
  const add = (n, make) => { D.nodes.push(Object.assign({ designers: [], engineers: [] }, n));
    if (make) D.links.push({ source: n.id, target: make, type: "made" }); };
  add({ id: "mk-t-opel", type: "make", label: "Opel", year: 1862 });
  add({ id: "fam-t-omega", type: "family", label: "Omega", make: "Opel", wp: "Opel Omega", year: 1986,
        generations: ["g-t-omega-a", "g-t-omega-b"] }, "mk-t-opel");
  [["g-t-omega-a", "Omega A", 1986], ["g-t-omega-b", "Omega B", 1994]].forEach(([id, label, year]) => {
    add({ id, type: "model", label, make: "Opel", familyOf: "fam-t-omega", wp: "Opel Omega", year });
    D.links.push({ source: "fam-t-omega", target: id, type: "generation" });
  });
  add({ id: "mk-t-daihatsu", type: "make", label: "Daihatsu", year: 1951 });
  add({ id: "m-t-opti", type: "model", label: "Opti", make: "Daihatsu", wp: "Daihatsu Opti", year: 1992 }, "mk-t-daihatsu");
  add({ id: "mk-t-ford", type: "make", label: "Ford", year: 1903 });
  add({ id: "m-t-fiesta6", type: "model", label: "Fiesta (sixth)", make: "Ford", wp: "Ford Fiesta (sixth generation)", year: 2008 }, "mk-t-ford");
  add({ id: "m-t-fiesta7", type: "model", label: "Fiesta (seventh)", make: "Ford", wp: "Ford Fiesta (seventh generation)", year: 2017 }, "mk-t-ford");
  add({ id: "mk-t-psa", type: "make", label: "Peugeot", year: 1810 });
  add({ id: "m-t-208", type: "model", label: "208", make: "Peugeot", wp: "Peugeot 208", year: 2012 }, "mk-t-psa");
  add({ id: "m-t-2008", type: "model", label: "2008", make: "Peugeot", wp: "Peugeot 2008", year: 2013 }, "mk-t-psa");
}
const scan = (engines) => ({ status: "ok", checkedAt: now, v: 2, unlinked: [], engines });
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    seed(window.CARDATA);
    window.LLM_FAMILIES = {
      families: {}, relations: {}, recheck: {},
      // the real mentions, as the store holds them
      engineScans: {
        "m-t-opti": scan([{ title: "List of Daihatsu engines", name: "JB-DET", variant: "JB-DET" }]),
        "m-t-fiesta6": scan([{ title: "List of Ford engines", name: "Fox", variant: "3 cylinder" }]),
        "m-t-fiesta7": scan([{ title: "List of Ford engines", name: "Duratec", variant: "1.1 L Duratec" }]),
        "m-t-208": scan([{ title: "List of PSA engines", name: "EB2DTS", variant: "EB" }]),
        "m-t-2008": scan([{ title: "List of PSA engines", name: "EB2LTEDH2", variant: "EB" }]),
      },
      // what the automatic pass recorded when every section of an index
      // looked like one article
      engineMerges: { "eng-ford-fox": { memberIds: ["eng-ford-1-1-l-duratec"], mergedAt: now } },
      __serverAvailable: true,
    };
  }
  window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
}
const cw = window.CarWeb; cw.boot();
const LF = window.LlmFamilies, D = window.CARDATA;
const live = id => D.nodes.find(n => n.id === id && !n.retired);
const fitted = id => D.links.filter(l => !l.retired && l.type === "fitted" &&
  [l.source, l.target].map(x => typeof x === "string" ? x : x.id).includes(id));

(async () => {
  // ---------- generation names ----------
  check("a code that already carries the nameplate is not prefixed again",
        LF.generationNodeLabel("Omega", "Omega B") === "Omega B", LF.generationNodeLabel("Omega", "Omega B"));
  check("...while a bare code still is", LF.generationNodeLabel("SL-Class", "R129") === "SL-Class R129");

  // ---------- which part of the Omega page a generation reads ----------
  const fam = cw.byId.get("fam-t-omega");
  for (const [id, head] of [["g-t-omega-a", "Omega A (1986–1994)"], ["g-t-omega-b", "Omega B (1994–2003)"]]) {
    const g = cw.byId.get(id);
    const sec = LF.nameplateSectionForCar(g, fam, OMEGA);
    check(`${g.label} reads its own section of the nameplate's page`, sec && sec.title === head, sec && sec.title);
    check(`...and is not sent to some other page`, LF.engineArticleFor(g, fam, OMEGA, "Opel Omega") === null,
          LF.engineArticleFor(g, fam, OMEGA, "Opel Omega"));
  }

  // ---------- engines linked by code ----------
  check("a bare engine-code link is an engine", LF.looksLikeCodeLink("X20SE", ""));
  check("a link displayed as an engine code is an engine", LF.looksLikeCodeLink("GM Ecotec Diesel (1997)", "X20DTH"));
  check("...but a technology link displayed as '16V' is not", !LF.looksLikeCodeLink("Multi-valve", "16V"));
  check("...nor is a layout link", !LF.looksLikeCodeLink("V6 engine", "V6"));
  await LF.scanEnginesFor(fam, D.nodes, D.links);
  const b = LF.engineScanEntryFor("g-t-omega-b") || {};
  const bTitles = (b.engines || []).map(x => x.title);
  check("the Omega B's engines are linked, not kept as plain text",
        bTitles.includes("X20SE") && bTitles.includes("GM Ecotec Diesel (1997)") && bTitles.includes("BMW M57"),
        JSON.stringify(bTitles));
  check("...with nothing left unlinked", !(b.unlinked || []).length, JSON.stringify(b.unlinked));
  const bNames = (b.engines || []).map(x => x.name);
  check("two engines written on one line as alternatives are both kept",
        bNames.includes("Y22XE") && bNames.includes("Z22XE") && bNames.includes("U25TD") && bNames.includes("X25TD"),
        JSON.stringify(bNames));
  const z = (b.engines || []).find(x => x.name === "Z22XE") || {};
  check("...each with the line's own specs", (z.specs || {}).displacement === "2.2 L", JSON.stringify(z.specs));
  const plain = LF.engineMentions("{{Infobox automobile\n| engine = 2.0 L [[Ford EcoBoost engine|EcoBoost]] [[Turbocharger|turbo]] [[Inline-four engine|I4]]\n}}");
  check("...while a line with one engine and describing links still gives one engine", plain.length === 1, plain.length);
  const a = LF.engineScanEntryFor("g-t-omega-a") || {};
  check("the Omega A's engines come from its own section", (a.engines || []).length >= 10 &&
        (a.engines || []).some(x => x.title === "Opel cam-in-head engine"), `${(a.engines || []).length} / ${a.sourceTitle}`);

  // ---------- sections of an index ----------
  const jb = LF.indexSectionEngine("List of Daihatsu engines", "JB-DET", "JB-DET");
  check("a section of an index is named for the section, with the index's maker", jb.label === "Daihatsu JB-DET", jb.label);
  const eb = LF.indexSectionEngine("List of PSA engines", "EB", "EB2DTS");
  check("...and the code the car used is its variant", eb.label === "PSA EB" && eb.variant === "EB2DTS", JSON.stringify(eb));
  const fox = LF.indexSectionEngine("List of Ford engines", "3 cylinder", "Fox");
  check("a section that only groups engines by shape does not name them", fox.label === "Ford Fox", fox.label);
  check("...'Four-cylinder' is such a section", LF.isGenericIndexSection("Four-cylinder"));
  check("...'EB' is not", !LF.isGenericIndexSection("EB"));

  check("the engine nodes carry those names", live("eng-daihatsu-jb-det") && live("eng-ford-fox") && live("eng-psa-eb"),
        D.nodes.filter(n => n.type === "engine").map(n => n.label).join(", "));
  check("two cars using the same section share one engine node",
        fitted("eng-psa-eb").length === 2, fitted("eng-psa-eb").length);
  check("...each fitted with the variant it named",
        fitted("eng-psa-eb").map(l => l.variantHint).sort().join(",") === "EB2DTS,EB2LTEDH2",
        fitted("eng-psa-eb").map(l => l.variantHint).join(","));
  check("different sections of one index are different engines",
        LF.engineArticleKey(live("eng-ford-fox")) !== LF.engineArticleKey(live("eng-ford-1-1-l-duratec")));
  check("a recorded merge of two different sections is not replayed",
        !!live("eng-ford-fox") && !!live("eng-ford-1-1-l-duratec") && fitted("eng-ford-1-1-l-duratec").length === 1,
        fitted("eng-ford-1-1-l-duratec").length);
  check("a code the article's title does not contain does not name the article's node",
        (live("eng-gm-ecotec-diesel-1997") || {}).label === "GM Ecotec Diesel (1997)",
        (live("eng-gm-ecotec-diesel-1997") || {}).label);

  // ---------- names stay put ----------
  const before = D.nodes.filter(n => n.type === "engine").map(n => n.label).join("|");
  const again = LF.relabelMisnamedEngines(D.nodes);
  check("a second renaming pass renames nothing", again === 0 &&
        D.nodes.filter(n => n.type === "engine").map(n => n.label).join("|") === before, again);
  const stray = { id: "eng-t-stray", type: "engine", label: "JB-DET", wp: "List of Daihatsu engines#JB-DET" };
  D.nodes.push(stray);
  LF.relabelMisnamedEngines(D.nodes);
  check("a code with no digit is not mistaken for a maker's name", !/^list of/i.test(stray.label), stray.label);
  const old = { id: "eng-t-old", type: "engine", label: "List of GM", wp: "List of GM engines#Four-cylinder" };
  D.nodes.push(old);
  LF.relabelMisnamedEngines(D.nodes);
  check("an index name is not replaced by a shape heading", old.label !== "Four-cylinder", old.label);
  const olds = { id: "eng-t-olds", type: "engine", label: "Oldsmobile", wp: "Oldsmobile V8 engine" };
  D.nodes.push(olds);
  LF.relabelMisnamedEngines(D.nodes);
  check("...while a maker's name on its own engine article still is fixed", olds.label === "Oldsmobile V8", olds.label);

  console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
