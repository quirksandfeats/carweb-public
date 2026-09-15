// Real user report: "In some cases, multiple engine variants of the same
// engine exist within the wikipedia page. Example:
// https://en.wikipedia.org/wiki/Mercedes-Benz_M276_engine. See if you can
// point the LLM to analyze the headers or separators in order to better
// detect any variants. Additionally, each of the variants in this case also
// have separate models associated with it."
//
// The variant reader was written against the M256, whose headings all begin
// with the engine's own code ("=== M256 E30 DEH LA GR ==="), and required
// exactly that. The M276 names its three variants "==DE35==", "==DE30 LA=="
// and "==DE35 LA==" -- level 2, engine code nowhere in them -- so all three
// were skipped and the engine reported as having no variants at all, which is
// what the card showed: "M276 · not read yet · 0 cars".
//
// Every article here is the real one, from qa/wiki_cache.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const CACHE = path.join(ROOT, "qa", "wiki_cache");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

const M276 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M276_engine.wikitext"), "utf-8");
const M256 = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M256_engine.wikitext"), "utf-8");
const N55 = fs.readFileSync(path.join(CACHE, "BMW_N55.wikitext"), "utf-8");
const M17X = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M176_M177_M178_engine.wikitext"), "utf-8");

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));

const FAM_GLE = "fam-mb-gle", G_W166 = "m-mb-gle-w166", G_V167 = "m-mb-gle-v167";
const FAM_ML = "fam-mb-ml", G_ML_W166 = "m-mb-ml-w166";
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-mb2", type: "make", label: "Mercedes-Benz", year: 1926 };
    D.nodes.push(mk);
    // Two nameplates with real generations, so "step down to the generation
    // the link text names" has somewhere to step to.
    [[FAM_GLE, "GLE-Class", [G_W166, G_V167]], [FAM_ML, "M-Class", [G_ML_W166]]].forEach(([id, label, gens]) => {
      D.nodes.push({ id, type: "family", label, make: "Mercedes-Benz", wp: "Mercedes-Benz " + label,
                     generations: gens, designers: [], engineers: [] });
      D.links.push({ source: id, target: mk.id, type: "made" });
    });
    [[G_W166, "GLE-Class (W166)", FAM_GLE], [G_V167, "GLE-Class (V167)", FAM_GLE],
     [G_ML_W166, "M-Class (W166)", FAM_ML]].forEach(([id, label, fam]) => {
      D.nodes.push({ id, type: "model", label, make: "Mercedes-Benz", familyOf: fam,
                     designers: [], engineers: [] });
      D.links.push({ source: fam, target: id, type: "generation" });
    });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
window.CarWeb.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- 1. the article that started this ----------
{
  const read = LF.readEngineArticle(M276, "Mercedes-Benz M276 engine");
  check("the M276's three variants are found", read.variants.length === 3,
        read.variants.map(v => v.code).join(" | "));
  const codes = read.variants.map(v => v.code);
  check("...named as the article's own prose names them, engine code included",
        codes.join(",") === "M276 DE35,M276 DE30 LA,M276 DE35 LA", codes.join(","));
  check("each variant carries its OWN application list",
        read.variants.every(v => v.applications.length > 0),
        read.variants.map(v => v.code + ":" + v.applications.length).join(" | "));
  // The applications sit in a "=== Applications ===" SUB-section of each
  // variant, not in the variant's own body -- the reason a section's text has
  // to include its descendants.
  check("...read out of each variant's own Applications sub-section",
        read.variants[0].applications.length === 15 &&
        read.variants[1].applications.length === 23 &&
        read.variants[2].applications.length === 5,
        read.variants.map(v => v.applications.length).join(","));
  check("...and they are different cars per variant, not the same list thrice",
        read.variants[2].applications.some(a => /Maybach/.test(a.display)) &&
        !read.variants[0].applications.some(a => /Maybach/.test(a.display)));
  check("nothing is double-counted at a parent level",
        !codes.some(c => /Applications|References/i.test(c)), codes.join(","));
}

// ---------- 2. the article it was written against still works ----------
{
  const read = LF.readEngineArticle(M256, "Mercedes-Benz M256 engine");
  check("the M256 still reports its own three variants", read.variants.length === 3,
        read.variants.map(v => v.code).join(" | "));
  check("...un-prefixed, because its headings already carry the code",
        read.variants.every(v => /^M256 /.test(v.code)) &&
        !read.variants.some(v => /^M256 M256/.test(v.code)),
        read.variants.map(v => v.code).join(" | "));
}

// ---------- 3. a heading that is NOT a variant ----------
{
  const read = LF.readEngineArticle(N55, "BMW N55");
  const codes = read.variants.map(v => v.code);
  check("the N55's designation headings are found", codes.some(c => /N55B30M0/.test(c)), codes.join(" | "));
  // The N55 article documents the S55 as well, under "==S55 engine==". That
  // is a different engine sharing a page, not a variant of this one.
  check("...but the S55, a separate engine on the same page, is not one of them",
        !codes.some(c => /S55/.test(c)), codes.join(" | "));
  check("...nor is 'Alpina' or a bare '272 kW version'",
        !codes.some(c => /Alpina|kW/.test(c)), codes.join(" | "));
}

// ---------- 4. stepping down to the generation the link names ----------
// Standing user rule: "Always prioritize showing only the generations instead
// of the full model if possible." The M276 links to the umbrella article and
// states the chassis code either in the link text or in a section anchor.
{
  const read = LF.readEngineArticle(M276, "Mercedes-Benz M276 engine");
  const apps = [];
  read.variants.forEach(v => v.applications.forEach(a => apps.push(a)));
  const viaText = apps.find(a => a.target === "Mercedes-Benz M-Class" && /W166 AMG GLE 43/.test(a.display));
  const viaAnchor = apps.find(a => a.target === "Mercedes-Benz GLE-Class" && a.anchor);
  check("(precondition) one application names the generation in its link text", !!viaText,
        viaText && viaText.display);
  check("(precondition) another names it in a section anchor", !!viaAnchor,
        viaAnchor && viaAnchor.anchor);

  const planned = LF.planEngineEdgesWith(apps, DATA.nodes, new Map(), () => null);
  check("an application landing on a nameplate is stepped down to its generation",
        planned.some(p => p.node.id === G_ML_W166),
        planned.map(p => p.node.id).join(","));
  const hit2 = planned.find(p => p.app === viaAnchor);
  check("...including when the code is only in the section anchor",
        hit2 && hit2.node.id === G_W166, hit2 && hit2.node.id);
  check("no edge is left hanging off a nameplate that named a generation",
        !planned.some(p => p.node.id === FAM_ML || p.node.id === FAM_GLE),
        planned.filter(p => p.node.type === "family").map(p => p.node.id).join(","));
}

// ---------- 5. one article, three engines ----------
// Real user report: reading the M177 failed outright with '"Mercedes-Benz
// M177 engine" is not an engine article.' Two separate reasons, both real:
// the page uses {{Infobox engine}} rather than {{Infobox automobile engine}},
// and it documents the M176, M177 and M178 together, one section each, with
// "Mercedes-Benz M177 engine" redirecting into it. "In this case, the LLM
// should search explicitly for the single engine that it is referring to, in
// this case the M177."
{
  check("the page is recognised as an engine article at all", LF.isEngineArticle(M17X));

  const m177 = LF.readEngineArticle(M17X, "Mercedes-Benz M177 engine");
  check("asking for the M177 does not return its two siblings as variants",
        !m177.variants.some(v => /M176|M178/.test(v.code)),
        m177.variants.map(v => v.code).join(" | ") || "(none)");
  // Its applications are a wikitable of Model | Years, not the bulleted list
  // every other engine page here uses -- and a bare "|" line was skipped on
  // purpose, as table furniture.
  check("its applications are read out of the wikitable", m177.applications.length >= 17,
        m177.applications.length);
  check("...with the years out of their own cell, not the head of the line",
        m177.applications.some(a => a.yearStart === 2015 && a.yearEnd === 2021),
        JSON.stringify(m177.applications[0] || null));
  check("...scoped to the M177's own table",
        m177.applications.some(a => /Aston Martin DB12/.test(a.display)) &&
        !m177.applications.some(a => /BAIC BJ90|Maybach S 560/.test(a.display)),
        m177.applications.map(a => a.display).slice(0, 3).join(" | "));

  const m176 = LF.readEngineArticle(M17X, "Mercedes-Benz M176 engine");
  check("asking for the M176 reads the M176's table instead",
        m176.applications.some(a => /BAIC BJ90/.test(a.display)) &&
        !m176.applications.some(a => /Aston Martin/.test(a.display)),
        m176.applications.length + ": " + m176.applications.map(a => a.display).slice(0, 2).join(" | "));
  check("...and they are genuinely different lists",
        m176.applications.length !== m177.applications.length,
        m176.applications.length + " vs " + m177.applications.length);

  // Asked for the combined page itself, there is no one engine to scope to,
  // so all three read as what they look like: sections of one article.
  const whole = LF.readEngineArticle(M17X, "Mercedes-Benz M176/M177/M178 engine");
  check("asked for the page itself, the three engines come back as its parts",
        whole.variants.length === 3, whole.variants.map(v => v.code).join(" | "));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
