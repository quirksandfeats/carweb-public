// A waiting nameplate re-check, settled by the article's own headings.
// Real user request (14 Oct 2026): re-checks should apply by themselves even
// when Wikipedia lists fewer generations, with safeguards, manual approval the
// exception. llm_families.js's decideRecheck holds the rules; this pins them
// on small cases modelled on the real ones they were written for, then
// applies one through the page to check links move and the order holds.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
function fakeCtx() { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); }

const FAM = "fam-testrule-falcon";
function boot(entry, extraNodes, extraLinks) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  ev("d3.min.js"); ev("data.js");
  const D = window.CARDATA;
  D.nodes.push({ id: "mk-testrule", type: "make", label: "TestRule" });
  (extraNodes || []).forEach(n => D.nodes.push(n));
  (extraLinks || []).forEach(l => D.links.push(l));
  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: entry ? { [FAM]: entry } : {}, __serverAvailable: true };
  ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
  return window;
}
const gen = (code, y0, y1) => ({ code, yearStart: y0, yearEnd: y1, designers: [], engineers: [], sharedPlatforms: [] });
const entry = (gens, sections) => ({ status: "provisional", checkedAt: new Date().toISOString(), sourceTitle: "TestRule Falcon",
  proposal: { hasMultipleGenerations: true, generations: gens }, attempts: 1, feedback: [], sections });
const node = (id, label, year, end, extra) => Object.assign({ id, type: "model", label, make: "TestRule", year, end, familyOf: FAM }, extra || {});
const famNode = gens => ({ id: FAM, type: "family", label: "Falcon", make: "TestRule", year: 1960, end: null, generations: gens, wp: "TestRule Falcon" });

// ---------- decideRecheck on its own ----------
function decide(gensOld, fresh, sections) {
  const w = boot(null);
  const LF = w.LlmFamilies;
  const fam = famNode(gensOld.map(g => g.id));
  const nodes = w.CARDATA.nodes.concat([fam], gensOld);
  return LF.decideRecheck(fam, gensOld, entry(fresh, sections), nodes);
}
const ids = list => list.map(x => x.id || x.code).join(",");

{
  const old = [node("g-xk", "Falcon (XK)", 1960, 1962), node("g-xl", "Falcon (XL)", 1962, 1964), node("g-xm", "Falcon (XM)", 1964, 1966)];
  const d = decide(old, [gen("First generation", 1960, 1966)],
    [[1, "First generation (1960–1966)"], [2, "XK"], [2, "XL"], [2, "XM"], [1, "References"]]);
  t("generations the re-read left out are kept when the article still has a heading for them (Falcon XK-XM)",
    d && ids(d.keep) === "g-xk,g-xl,g-xm" && !d.retire.length, d && ids(d.keep));
  t("...and the coarser entry their years already cover is not added (the owner's Falcon ruling)",
    d && !d.add.length && d.skip.some(s => /finer/.test(s.why)), d && JSON.stringify(d.skip));
}
{
  const old = [node("g-bare", "Falcon", 1960, 1975), node("g-2", "Falcon (second generation)", 1976, 1985)];
  const d = decide(old, [gen("First generation", 1960, 1975), gen("Second generation", 1976, 1985)],
    [[1, "First generation (1960–1975)"], [1, "Second generation (1976–1985)"]]);
  t("the bare nameplate standing in for a generation is paired with the one its years match, not retired",
    d && d.paired[0] && d.paired[0].id === "g-bare" && !d.retire.length, d && JSON.stringify(d.paired.map(x => x && x.id)));
}
{
  const old = [node("g-1", "Falcon (first generation)", 1960, 1975), node("g-1b", "Falcon Mk1", 1960, 1975), node("g-2", "Falcon (second generation)", 1976, 1985)];
  const d = decide(old, [gen("First generation", 1960, 1975), gen("Second generation", 1976, 1985)],
    [[1, "First generation (1960–1975)"], [1, "Second generation (1976–1985)"]]);
  t("a duplicate of a generation kept here (its heading already stands for one) is retired", d && ids(d.retire) === "g-1b", d && ids(d.retire));
}
{
  const old = [node("g-bare", "Falcon", 1960, 2017), node("g-st", "Falcon (Statesman)", 1971, 1984)];
  const d = decide(old, [gen("Statesman (HQ–WB)", 1971, 1984), gen("VQ", 1990, 1991)],
    [[1, "Statesman (HQ–WB; 1971–1984)"], [1, "First generation (1990–1999)"], [2, "VQ"], [1, "Sales"]]);
  t("nothing is retired whose years the rest would not cover (Holden Caprice)", d && !d.retire.length && d.keep.some(o => o.id === "g-bare"),
    d && ids(d.retire));
  t("...and a series inside another generation's section is not added as a generation", d && !d.add.length, d && ids(d.add));
}
{
  const old = [node("g-1", "Falcon (first generation)", 1960, 1975)];
  const d = decide(old, [gen("First generation", 1960, 1975), gen("Second generation (2016)", 2016, 2022),
                         gen("Falcon Ute (2018)", 2018, 2020), gen("GS platform", 2016, 2022), gen("Chevrolet Falcon (Brazil)", 1970, 1980),
                         gen("TestRule Comet", 1980, 1990)],
    [[1, "First generation (1960–1975)"], [1, "Second generation (2016)"], [2, "Falcon Ute (2018)"], [1, "Other uses of the Falcon name"], [2, "Chevrolet Falcon (Brazil)"]]);
  t("a generation with a generation-level heading is added", d && d.add.map(g => g.code).join() === "Second generation (2016)", d && d.add.map(g => g.code).join());
  const why = c => (d.skip.find(s => s.code === c) || {}).why || "";
  t("...a subsection of another generation is not", /no generation-level/.test(why("Falcon Ute (2018)")), why("Falcon Ute (2018)"));
  t("...nor an entry only its years tie to a heading", /no generation-level/.test(why("GS platform")), why("GS platform"));
  t("...nor one under \"Other uses\"", /no generation-level/.test(why("Chevrolet Falcon (Brazil)")), why("Chevrolet Falcon (Brazil)"));
  t("...nor one naming another model of the make", /another car/.test(why("TestRule Comet")), why("TestRule Comet"));
}
{
  const old = [node("g-1", "Falcon (XA)", 1972, 1973)];
  const d = decide(old, [gen("XB", 1973, 1976)], [[1, "XA (1972–1973)"], [1, "XB (1973–1976)"]]);
  t("a generation with its own heading stays even if the re-read dropped it, and the new one is added",
    d && ids(d.keep) === "g-1" && d.add.map(g => g.code).join() === "XB");
}
{
  const old = [node("g-1", "Falcon (XA)", 1972, 1973, { wp: "TestRule Falcon (XA)" }), node("g-2", "Falcon (XB)", 1973, 1976)];
  const d = decide(old, [gen("XB", 1973, 1976)], [[1, "Production"]]);
  t("a generation with its own article stays", d && ids(d.keep) === "g-1", d && ids(d.keep));
}
t("an entry without the article's headings is not decided by rule", decide([node("g-1", "Falcon (XA)", 1972, 1973)], [gen("XB", 1973, 1976)], undefined) === null);

// ---------- applied by the rules: links move, the order holds ----------
{
  const nodes = [famNode(["g-c", "g-b", "g-dup"]),
    node("g-b", "Falcon (second generation)", 1980, 1989), node("g-c", "Falcon (third generation)", 1990, 1999),
    node("g-dup", "Falcon Mk2", 1980, 1989),
    { id: "m-other", type: "model", label: "Other Car", make: "TestRule", year: 1985, end: 1990 }];
  const links = [{ source: FAM, target: "mk-testrule", type: "made" },
    { source: FAM, target: "g-c", type: "generation" }, { source: FAM, target: "g-b", type: "generation" }, { source: FAM, target: "g-dup", type: "generation" },
    { source: "g-c", target: "g-b", type: "gensucc" },
    { source: "g-dup", target: "m-other", type: "platform" }];
  const e = entry([gen("Second generation", 1980, 1989), gen("Third generation", 1990, 1999), gen("Fourth generation (2000)", 2000, 2009)],
    [[1, "Second generation (1980–1989)"], [1, "Third generation (1990–1999)"], [1, "Fourth generation (2000–2009)"]]);
  const w = boot(e, nodes, links);
  const cw = w.CarWeb; cw.boot();
  const fam = cw.byId.get(FAM);
  const st = w.LlmFamilies.recheckEntryFor(FAM);
  t("the page applied it at load by the rules", st && st.status === "applied", st && st.status);
  t("the duplicate was retired and recorded on the entry", cw.byId.get("g-dup").retired && (st.retiredGenerations || []).some(r => r.id === "g-dup"));
  const order = fam.generations.map(id => cw.byId.get(id).label).join(" | ");
  t("the generations are in order of their years, the new one last", /second.*third.*Fourth/i.test(order), order);
  const plat = cw.links.find(l => l.type === "platform" && !l.retired &&
    [l.source, l.target].map(x => typeof x === "string" ? x : x.id).sort().join() === ["g-b", "m-other"].sort().join());
  t("the retired duplicate's platform link moved to the generation its years match", !!plat);
  t("...and the duplicate records where it went", cw.byId.get("g-dup").supersededBy === "g-b");
  const succ = cw.links.filter(l => l.type === "gensucc" && !l.retired && fam.generations.concat(["g-dup"]).includes(typeof l.source === "string" ? l.source : l.source.id)).map(l => [l.source, l.target].map(x => typeof x === "string" ? x : x.id).join(">"));
  t("the succession arrows follow the order, the stale reversed one gone",
    succ.includes("g-b>g-c") && !succ.includes("g-c>g-b"), succ.join(" "));
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
