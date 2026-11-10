// A nameplate whose article runs several bodies side by side: each body succeeds only
// itself, and a generation of one body ends nothing for another (the 2 Series F45/F46,
// which showed 2014-2016 because the M2 F87 began in 2016).
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
const span = id => { const n = nodes.find(x => x.id === id); return n && n.year + "-" + n.end; };

check("F45/F46 ends when its article says", span("llm-fam-bmw-2-series-f45-f46") === "2014-2021", span("llm-fam-bmw-2-series-f45-f46"));
check("U06 still built", span("llm-fam-bmw-2-series-u06") === "2021-null", span("llm-fam-bmw-2-series-u06"));
check("M2 G87 still built", span("llm-fam-bmw-2-series-g87") === "2023-null", span("llm-fam-bmw-2-series-g87"));
check("the stated ends stay", span("m-bmw-2-series-f22") === "2013-2021" && span("llm-fam-bmw-2-series-f87") === "2016-2021" && span("llm-fam-bmw-2-series-f44") === "2020-2024");

for (const [a, b] of [
  ["m-bmw-2-series-f22", "m-bmw-2-series-g42"],
  ["llm-fam-bmw-2-series-f87", "llm-fam-bmw-2-series-g87"],
  ["llm-fam-bmw-2-series-f45-f46", "llm-fam-bmw-2-series-u06"],
  ["llm-fam-bmw-2-series-f44", "llm-fam-bmw-2-series-f74-f78"],
  ["llm-m-ford-raptor-second-generation-2017", "llm-m-ford-raptor-third-generation-2021"],
  ["llm-m-ford-raptor-first-generation-2019", "llm-m-ford-raptor-second-generation-2022"],
]) check(a + " is followed by " + b, succ.has(a + ">" + b));
for (const [a, b] of [
  ["m-bmw-2-series-f22", "llm-fam-bmw-2-series-f45-f46"],
  ["llm-fam-bmw-2-series-f45-f46", "llm-fam-bmw-2-series-f87"],
  ["m-bmw-2-series-g42", "llm-fam-bmw-2-series-u06"],
  ["llm-m-ford-raptor-third-generation-2021", "llm-m-ford-raptor-first-generation-2019"],
]) check(a + " is not followed by " + b, !succ.has(a + ">" + b));

// A family with no lines keeps its one chain by year.
const fam = nodes.find(n => n.id === "fam-toyota-corolla");
const chain = fam.generations.map(id => nodes.find(n => n.id === id)).filter(g => g && !g.retired && !g.future && g.year != null);
check("a family without lines still chains", links.some(l => live(l) && l.type === "gensucc" && chain.some(g => g.id === idOf(l.source)) && chain.some(g => g.id === idOf(l.target))));

// The lines come from the article's headings, with nothing written down per nameplate.
const lineCount = id => (LF.generationLines(id) || []).length;
check("the 2 Series reads as four lines", lineCount("fam-bmw-2-series") === 4);
check("the Raptor reads as two lines", lineCount("m-ford-raptor") === 2);
check("eras are one sequence (the Transporter's Type 2 and Multivan)", lineCount("fam-volkswagen-transporter") === 0);
check("a generation heading is not a body (the Falcon)", lineCount("m-ford-falcon-australia") === 0);
check("a generation heading is not a body (the V70)", lineCount("m-volvo-v70") === 0);

// A read's end past the next start shows only where the generation's own card names it.
const node = id => nodes.find(n => n.id === id);
for (const [id, end] of [
  ["llm-m-nissan-cedric-y31", 2002], ["llm-m-nissan-cedric-y30", 1999], ["llm-m-toyota-hilux-n30-n40", 1988],
  ["llm-m-nissan-navara-d40", 2021], ["llm-m-maruti-suzuki-wagon-r-second-generation-mp31s", 2025],
  ["m-toyota-corolla-e70", 1987], ["m-volkswagen-golf-mk4", 2006], ["llm-m-opel-meriva-meriva-a", 2013],
]) check(id + " shows its overlap", node(id).end === end, node(id).end);
const notOnCard = [["fam-chrysler-valiant", "CL"], ["m-hyundai-genesis", "BH"], ["m-daihatsu-move", "L600"]];
check("a read with no card behind it stays out", node("llm-m-hyundai-genesis-bh") ? node("llm-m-hyundai-genesis-bh").end === 2013 : true);
for (const [fam, code] of notOnCard) {
  const g = shipped.recheck[fam].proposal.generations.find(x => x.code === code);
  check(fam + " " + code + " carries no mark", !g.endOnCard);
}

// An overlap moves no link: cars pair with the generation that had taken over.
const between = (a, b) => links.some(l => live(l) && l.type === "platform" &&
  ((idOf(l.source) === a && idOf(l.target) === b) || (idOf(l.source) === b && idOf(l.target) === a)));
check("the J30 stays on the Y32", between("m-infiniti-j30", "llm-m-nissan-cedric-y32"));
check("the J30 does not go to the Y30", !between("m-infiniti-j30", "llm-m-nissan-cedric-y30"));
check("a handover is kept beside the shown end", node("llm-m-nissan-cedric-y31").handover === 1991);
check("the Y31 still leads to the Y32", succ.has("llm-m-nissan-cedric-y31>llm-m-nissan-cedric-y32"));

// A new scan marks its own read.
const section = (title, card) => "== " + title + " ==\n{{Infobox automobile\n| name = X\n" + card + "\n}}\nProse.\n\n";
const gen = (code, yearStart, yearEnd) => ({ code, yearStart, yearEnd, designers: [], engineers: [], sharedPlatforms: [] });
const read = (gens, text) => { LF.endYearsFromOwnCards(gens, text); return gens; };
{
  const [a] = read([gen("AB1", 1983, 1999), gen("AB2", 1987, 1991)], section("First generation (AB1; 1983)",
    "| production = {{unbulleted list | 1983–1987 | 1983–1999 (wagon/van) }}") + section("Second generation (AB2; 1987)", "| production = 1987–1991"));
  check("a card's market or body end marks the read", a.endOnCard === true && a.yearEnd === 1999);
}
{
  const [a] = read([gen("AB1", 1978, 1988), gen("AB2", 1983, 1988)], section("First generation (AB1; 1978)",
    "| production = August 1978 – October 1983 (extended until September 1988)") + section("Second generation (AB2; 1983)", "| production = 1983–1988"));
  check("\"extended until\" counts", a.endOnCard === true);
}
{
  const [a] = read([gen("AB1", 2000, 2010), gen("AB2", 2005, null)], section("First generation (AB1; 2000)",
    "| production = {{ubl | 2000–2005 (Japan) | 2010–2012 (Taiwan) }}") + section("Second generation (AB2; 2005)", "| production = 2005–present"));
  check("the year as another range's start does not count", !a.endOnCard);
}
{
  const gens = [gen("AB1", 2008, 2016), gen("AB2", 2013, 2016)];
  LF.endYearsFromOwnCards(gens, section("First generation (AB1; 2008)", "| production = 2008–2013") + section("Second generation (AB2; 2013)", "| production = 2013–2016"));
  check("a read of the nameplate's end takes the card's instead", gens[0].yearEnd === 2013 && gens[0].endOnCard === true);
}
{
  const text = "== First generation (AB1; 1970) ==\nProse.\n\n== Second generation (AB2; 1974) ==\nProse.\n";
  const page = "{{Infobox automobile\n| production = May 1970 – July 1974 (sedan), May 1970 – May 1978 (wagon)\n}}\n";
  const w = text + "\n\n" + page;
  const gens = [gen("AB1", 1970, 1978), gen("AB2", 1974, 1979)];
  LF.endYearsFromOwnCards(gens, w, [{ title: "Example (AB1)", at: text.length + 2, stop: w.length }]);
  check("the generation's own page counts", gens[0].endOnCard === true && !gens[1].endOnCard);
}

// Ends the articles settle, in both directions, and the pairing year stays put.
for (const [id, start, end] of [
  ["llm-llm-related-holden-utility-ht", 1969, 1970], ["llm-llm-related-holden-utility-hg", 1970, 1971],
  ["llm-llm-related-holden-utility-hq", 1971, 1974],
]) check(id, node(id).year === start && node(id).end === end, node(id).year + "-" + node(id).end);
check("the Holden Utility runs HK, HT, HG, HQ",
  succ.has("llm-llm-related-holden-utility-hk>llm-llm-related-holden-utility-ht") &&
  succ.has("llm-llm-related-holden-utility-ht>llm-llm-related-holden-utility-hg") &&
  succ.has("llm-llm-related-holden-utility-hg>llm-llm-related-holden-utility-hq"));
const crown = "llm-m-toyota-crown-eighth-generation-s130";
check("the Crown S130 is one car", (!node(crown + "-1987") || node(crown + "-1987").retired) && node(crown).end === 2000);
check("the Crown S130 still leads to the S140", succ.has(crown + ">llm-m-toyota-crown-ninth-generation-s140"));
const byLabel = (make, label) => nodes.find(n => !n.retired && n.make === make && n.label === label);
const shorter = byLabel("Land Rover", "Freelander L359");
check("an earlier end on the card shows, and pairing keeps the old one", shorter.end === 2014 && shorter.handover === 2015);
{
  const f = nodes.find(n => n.id === "m-toyota-crown");
  check("a family's generations are all still there", (f.generations || []).filter(id => node(id) && !node(id).retired).length >= 15);
}
{
  const [a] = read([gen("AB1", 1951, 1951), gen("AB2", 1953, 1955)], section("First generation (AB1; 1951)",
    "| production = {{unbulleted list|1951|One produced}}") + section("Second generation (AB2; 1953)", "| production = 1953–1955"));
  check("a single year on the card counts", a.endOnCard === true);
}
{
  const [a] = read([gen("AB1", 2000, 2006), gen("AB2", 2004, null)], section("First generation (AB1; 2000)",
    "| production = {{ubl | 2000–2006 | 2004–2011 (China) }}") + section("Second generation (AB2; 2004)", "| production = 2004–present"));
  check("the card's ends are kept with the mark", a.endOnCard === true && a.cardEnds.includes(2006) && a.cardEnds.includes(2011));
}
const rule = [["a heading's run outranks a card", node("llm-m-ford-ranger-americas-third-generation-1998-2012"), 2012],
  ["\"present\" in a heading outranks a card", byLabel("Mitsubishi", "Delica D:3 Third generation (1986–present)"), null]];
for (const [name, n, end] of rule) if (n) check(name, n.end === end, n.end);

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
