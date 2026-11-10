// When a car stopped being built, from one rule: lastBuiltOnCard. Scans apply it by
// themselves; scripts/article_ends.js runs it for cars not re-scanned since it arrived.
// Cars may overlap their successors, and the start years keep the order.
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
const nodes = window.CARDATA.nodes, links = window.CARDATA.links;
const LF = window.LlmFamilies;
const live = l => !l.retired;
const idOf = v => (typeof v === "string" ? v : v.id);
const succ = new Set(links.filter(l => live(l) && l.type === "gensucc").map(l => idOf(l.source) + ">" + idOf(l.target)));
const at = id => nodes.find(x => x.id === id);
const span = id => { const n = at(id); return n && n.year + "-" + n.end; };

// The rule, on real production fields.
const said = (f, make, label) => { const r = LF.lastBuiltOnCard(f, make, label); return r ? r.end : r; };
check("the last year built anywhere: the 405 in Azerbaijan", said("1987–1997 (Europe)<br />1992–2022 (Iran)<br />2019–2023 (Azerbaijan)", "Peugeot", "405") === 2023);
check("still built somewhere means running: the 206", said("{{ubl | May 1998 – December 2012 (France) | April 2001 – present (Iran) }}", "Peugeot", "206") === null);
check("a line for another car does not count: the SEAT Mii", said("{{ubl | 2011–2023 (Volkswagen up!) | 2011–2020 (Škoda Citigo) | 2011–2021 (SEAT Mii) }}", "SEAT", "Mii") === 2021);
check("nor does a rebadge under its own maker: the ZX", said("1991–1998 (Citroën ZX)<br />1992–2009 (Citroën Fukang)", "Citroën", "ZX") === 1998);
check("a continuation decades later is not this production: the DB5", said("{{ubl |1963–1965 (1,059 units)|2020 (25 units)}}", "Aston Martin", "DB5") === 1965);
check("the Dacia 2000 is not the Renault 20", said("1975–1986 (Renault 30)<br />1976–1986 (Renault 20)<br />1979–1989 (Dacia 2000)", "Renault", "20/30") === 1986);
check("the 1500TC is the 1500", said("1500: 1970–1973; 66,353 built; 1500TC: 1973–1976; 25,549 built", "Triumph", "1500") === 1976);
check("a shortened year", said("1920–27<br />1500 approx produced", "ABC", "1920 automobile") === 1927);
check("a count is not a year", said("1923–26<br />2500 made (see text)", "Triumph", "10/20") === 1926);
check("a date is not a shortened year", said("1955–30 June 1969", "BMW", "Goggomobil") === 1969);
check("a citation's date is not a year", said("{{ubl |1939–1941{{source?|date=August 2019}}|11 produced}}", "Bentley", "Mark V") === 1941);
check("the first prototype does not make a concept", said("1959–1981 (first prototype made in 1955 or 1956)", "GAZ", "13") === 1981);
check("a concept counts when there is nothing else", said("2016 (concept car)", "Cadillac", "Escala") === 2016);
check("nothing built yet says nothing", said("2029 (to commence)", "Hennessey", "Blackbird") === undefined);
check("a hedged year does not count", said("1958–1965 (possibly 1967)", "Hongqi", "CA72") === 1965);
check("an old open dash says nothing", said("2009-", "Aspid", "IFR") === undefined);
check("a card about another era does not fit", !LF.cardFitsCar({ first: 1962, end: 1976 }, { year: 1955 }));
check("a card that began before the car's own start fits", LF.cardFitsCar({ first: 2008, end: 2018 }, { year: 2014 }));

// The shipped graph.
check("the 206 runs on", span("m-peugeot-206") === "1998-null", span("m-peugeot-206"));
check("the XC40 is still built", span("m-volvo-xc40") === "2017-null", span("m-volvo-xc40"));
check("the Type 3 ended in 1973", span("m-volkswagen-type-3") === "1961-1973", span("m-volkswagen-type-3"));
check("the 405 overlaps its successors", span("m-peugeot-405") === "1987-2023", span("m-peugeot-405"));
check("the Mark 1 is no longer running", span("m-jaguar-mark-1") === "1955-1959", span("m-jaguar-mark-1"));
check("the Mii keeps its own end", span("m-seat-mii") === "2011-2021", span("m-seat-mii"));
check("the 405 still pairs by the end it had", at("m-peugeot-405").handover === 1997, at("m-peugeot-405").handover);
check("a car with no end before still pairs that way", at("m-jaguar-mark-1").handover === null && at("m-jaguar-mark-1").shownEndFromArticle === true);
check("the NSX runs as long as its generations", at("fam-honda-nsx").end === 2022, at("fam-honda-nsx").end);
check("a generation is left to its own rules", !at("m-toyota-corolla-e120").shownEndFromArticle);

// Start year sets the order, overlap or not.
const gens = id => at(id).generations.map(at).filter(g => g && !g.retired && g.year != null);
const backwards = [];
links.forEach(l => {
  if (l.retired || l.type !== "gensucc") return;
  const a = at(idOf(l.source)), b = at(idOf(l.target));
  if (a && b && !a.retired && !b.retired && a.familyOf && a.familyOf === b.familyOf && a.year != null && b.year != null && b.year < a.year) backwards.push(a.id);
});
check("no generation is followed by one that began earlier", backwards.length === 0, backwards.slice(0, 5).join());
check("the Cruze is in order", succ.has("llm-m-chevrolet-cruze-d2sc>llm-m-chevrolet-cruze-d2lc"));
// The Falcon (Australia) read from its article is folded into the build data's
// Falcon (10 Nov 2026), whose generations have articles of their own.
const years = gens("fam-ford-falcon").map(g => g.year);
check("the list follows too", years.every((y, i) => !i || years[i - 1] <= y), years.join());

// A scan marks a one-car article by itself.
const raw = { hasMultipleGenerations: false, generations: [{ code: "Test Car", yearStart: 2000, yearEnd: 2004 }] };
const clean = LF.__validateForTest(raw, "Test Car is a car.\n{{Infobox automobile\n| name = Test Car\n| production = 2000–2004<br />2003–2010 (Brazil)\n| assembly = Here\n}}\nThe Test Car was built.");
const g = clean && clean.generations && clean.generations[0];
check("a scan keeps the card's production field", !!g && /Brazil/.test(g.cardProduction || ""), g && g.cardProduction);

console.log(fails ? fails + " failure(s)" : "ALL GREEN");
process.exit(fails ? 1 : 0);
