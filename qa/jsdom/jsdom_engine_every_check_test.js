// Real user reports, one batch:
//  - "Honda Legend Fourth generation (KB1/2) ... has the engine information but
//    says there's no article associated with the engine" -- the infobox links
//    "[[Honda J35|J35A]]", a title with no "engine" in it.
//  - "Daihatsu Thor ... engine was not even picked up" -- the check never went
//    on to read engines at all.
//  - "Daimler Conquest nameplate, none of the cars have engines associated" --
//    one infobox for the whole page, no per-generation sections.
//  - "Do not include engine information in the overview of a nameplate"
//    (Nissan Silvia), and an S13-named nameplate is the Silvia.
//  - Generation splits waiting for approval get their own panel, and a list
//    with as many generations or more replaces the old one unasked.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app"), CACHE = path.resolve(__dirname, "..", "wiki_cache");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const read = f => fs.readFileSync(path.join(CACHE, f + ".wikitext"), "utf-8");
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
const fakeCtx = () => new Proxy({ measureText: () => ({ width: 10 }) },
  { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });

const ARTICLES = {
  "Honda Legend": read("Honda_Legend"),
  "Daihatsu Thor": read("Daihatsu_Thor"),
  "Daimler Conquest": read("Daimler_Conquest"),
};

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1; window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = (url) => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    const wt = ARTICLES[title];
    if (!wt) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": wt } } }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;

const now = new Date().toISOString();
const gen = (code, y0, y1) => ({ code, yearStart: y0, yearEnd: y1, designers: [], engineers: [], sharedPlatforms: [] });
const provisional = (gens, title) => ({ status: "provisional", checkedAt: now, sourceTitle: title,
  proposal: { hasMultipleGenerations: true, generations: gens }, attempts: 1, feedback: [] });

function seed(D) {
  const add = (n, make) => { D.nodes.push(Object.assign({ designers: [], engineers: [] }, n));
    if (make) D.links.push({ source: n.id, target: make, type: "made" }); };
  add({ id: "mk-t-honda", type: "make", label: "Honda", year: 1948 });
  add({ id: "mk-t-daihatsu", type: "make", label: "Daihatsu", year: 1951 });
  add({ id: "mk-t-daimler", type: "make", label: "Daimler", year: 1896 });
  add({ id: "mk-t-nissan", type: "make", label: "Nissan", year: 1933 });
  add({ id: "mk-t-audi", type: "make", label: "Audi", year: 1909 });
  add({ id: "mk-t-mb", type: "make", label: "Mercedes-Benz", year: 1926 });
  const family = (id, label, make, makeId, wp, gens) => {
    add({ id, type: "family", label, make, wp, year: gens[0][2], generations: gens.map(g => g[0]) }, makeId);
    gens.forEach(([gid, glabel, y]) => {
      add({ id: gid, type: "model", label: glabel, make, familyOf: id, wp, year: y });
      D.links.push({ source: id, target: gid, type: "generation" });
    });
  };
  family("fam-t-legend", "Legend", "Honda", "mk-t-honda", "Honda Legend",
         [["g-t-legend-4", "Legend Fourth generation (KB1/2)", 2004]]);
  add({ id: "m-t-thor", type: "model", label: "Thor", make: "Daihatsu", wp: "Daihatsu Thor", year: 2016 }, "mk-t-daihatsu");
  family("fam-t-conquest", "Conquest", "Daimler", "mk-t-daimler", "Daimler Conquest",
         [["g-t-conq-1", "Conquest Mark I", 1953], ["g-t-conq-2", "Conquest Mark II", 1955]]);
  family("fam-t-silvia", "Silvia (S13)", "Nissan", "mk-t-nissan", "Nissan Silvia",
         [["g-t-silvia-s13", "Silvia (S13)", 1988], ["g-t-silvia-s14", "Silvia (S14)", 1993]]);
  family("fam-t-sl", "SL", "Mercedes-Benz", "mk-t-mb", "Mercedes-Benz SL-Class",
         [["g-t-sl-r129", "SL (R129)", 1989], ["g-t-sl-r230", "SL (R230)", 2001]]);
  // pending first splits
  add({ id: "m-t-audi80", type: "model", label: "80", make: "Audi", wp: "Audi 80", year: 1966 }, "mk-t-audi");
  add({ id: "m-t-audi80b1", type: "model", label: "80 (B1)", make: "Audi", wp: "Audi 80", year: 1972 }, "mk-t-audi");
  add({ id: "m-t-coupe-c9", type: "model", label: "Coupe (C9)", make: "Nissan", wp: "Nissan Coupe", year: 1990 }, "mk-t-nissan");
  add({ id: "m-t-plain", type: "model", label: "Plainline", make: "Nissan", wp: "Nissan Plainline", year: 1990 }, "mk-t-nissan");
}

for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    seed(window.CARDATA);
    window.LLM_FAMILIES = {
      families: {
        "m-t-audi80b1": provisional([gen("B1", 1972, 1978), gen("B2", 1978, 1986), gen("B3", 1986, 1991)], "Audi 80"),
        "m-t-coupe-c9": provisional([gen("C9", 1990, 1994), gen("C10", 1994, 1999)], "Nissan Coupe"),
        "m-t-plain": provisional([gen("A1", 1990, 1994), gen("A2", 1994, 1999)], "Nissan Plainline"),
        // a nameplate recorded as deferring to another car's article
        "fam-t-sl": { status: "same-article", checkedAt: now, sourceTitle: "Mercedes-Benz SL-Class",
                      sameAs: "g-t-sl-r129", sameAsLabel: "Mercedes-Benz SL (R129)", attempts: 1 },
      },
      relations: {}, recheck: {},
      // read once as a plain car, before it was split
      engineScans: { "fam-t-silvia": { status: "ok", checkedAt: now, v: 2, unlinked: [],
        engines: [{ title: "Nissan SR engine", name: "SR20DET", variant: "SR20DET" }] } },
      __serverAvailable: true,
    };
  }
  window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
}
const cw = window.CarWeb; cw.boot();
const LF = window.LlmFamilies, D = window.CARDATA;
const fittedTo = id => D.links.filter(l => !l.retired && l.type === "fitted" &&
  [l.source, l.target].map(x => typeof x === "string" ? x : x.id).includes(id))
  .map(l => { const s = typeof l.source === "string" ? l.source : l.source.id; return s === id ? (typeof l.target === "string" ? l.target : l.target.id) : s; });
const label = id => (D.nodes.find(n => n.id === id) || {}).label;

// ---------- parsing ----------
{
  const m = LF.engineMentions("{{Infobox automobile\n| engine = [[Honda J35|J35A]] 3.5 L [[V6 engine|V6]]\n}}");
  check("an engine link whose title has no 'engine' in it is still an engine", m.some(x => x.title === "Honda J35"),
        JSON.stringify(m.map(x => x.title)));
  check("...and the V6 layout link is not", !m.some(x => /V6 engine/.test(x.title)));
  const thor = LF.engineMentions(ARTICLES["Daihatsu Thor"]);
  check("the Thor's own article names the Toyota KR", thor.some(x => /Toyota KR/.test(x.title)),
        JSON.stringify(thor.map(x => x.title)));
}

(async () => {
  // ---------- boot-time repairs ----------
  check("a nameplate split under one of its generations is given its base name", label("fam-t-silvia") === "Silvia", label("fam-t-silvia"));
  check("a split nameplate carries no engines on its own card", fittedTo("fam-t-silvia").length === 0, fittedTo("fam-t-silvia"));
  check("a nameplate never defers to another car's article", !LF.entryFor("fam-t-sl"),
        JSON.stringify(LF.entryFor("fam-t-sl")));
  const b1 = LF.entryFor("m-t-audi80b1");
  check("a pending split for 'Audi 80 (B1)' is folded into the Audi 80 already in the graph",
        b1 && b1.status === "same-article" && b1.generationOf === "m-t-audi80", JSON.stringify(b1));
  check("a pending split named for its own generation, with no nameplate in the graph, takes the base name",
        label("m-t-coupe-c9") === "Coupe", label("m-t-coupe-c9"));

  // ---------- pending splits panel ----------
  const rows = LF.pendingSplits(D.nodes);
  const ids = rows.map(r => r.id);
  check("the panel lists the waiting first splits", ids.includes("m-t-coupe-c9") && ids.includes("m-t-plain"), ids.join(","));
  check("...but not the one that turned out to be a generation", !ids.includes("m-t-audi80b1"));
  check("...and a plain car's first split meets the auto-apply rule", rows.find(r => r.id === "m-t-plain").meetsRule);
  LF.declineSplit("m-t-plain", "first");
  check("declining takes it off the list", !LF.pendingSplits(D.nodes).some(r => r.id === "m-t-plain"));
  check("...and is remembered", (LF.entryFor("m-t-plain") || {}).status === "rejected");

  // ---------- engines read from every kind of car ----------
  await LF.scanEnginesFor(cw.byId.get("m-t-thor"), D.nodes, D.links);
  const thorEng = fittedTo("m-t-thor");
  check("a plain model's engines are read and linked", thorEng.length >= 1, thorEng.join(","));
  check("...on a node named for the article, not the first code that linked it",
        thorEng.every(id => label(id) === "Toyota KR"), thorEng.map(label).join(","));

  await LF.scanEnginesFor(cw.byId.get("fam-t-legend"), D.nodes, D.links);
  const leg = fittedTo("g-t-legend-4");
  check("the Legend's fourth generation is linked to its J35", leg.includes("eng-honda-j35"), leg.join(","));

  await LF.scanEnginesFor(cw.byId.get("fam-t-conquest"), D.nodes, D.links);
  const c1 = LF.engineScanEntryFor("g-t-conq-1") || {};
  const said = [...(c1.engines || []).map(x => x.name || x.title), ...(c1.unlinked || []).map(x => x.name)];
  check("a nameplate with one infobox gives its engine to each generation", said.length >= 1, JSON.stringify(c1));
  check("...recorded against the current reader", (c1.v || 1) >= 2, c1.v);

  // ---------- search tag is not see-through ----------
  const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
  const base = (css.match(/\.sr-type\{[^}]*\}/) || [""])[0];
  check("the search result's type tag has a background of its own", /background:/.test(base), base);
  check("...including engine and variant tags", /\.sr-type\.engine\{[^}]*background/.test(css) && /\.sr-type\.enginevar\{[^}]*background/.test(css));

  console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
