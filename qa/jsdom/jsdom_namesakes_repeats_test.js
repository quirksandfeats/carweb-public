// A person's dates found by name alone can be a namesake's, and a nameplate can list one
// generation twice (5 Nov 2026).
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
const DATA = window.CARDATA;
const idOf = v => (typeof v === "string" ? v : v.id);
const N = id => DATA.nodes.find(n => n.id === id);
const named = (id, type = "platform") => DATA.links.filter(l => !l.retired && !l.mirror && l.type === type && (idOf(l.source) === id || idOf(l.target) === id))
  .map(l => idOf(l.source) === id ? idOf(l.target) : idOf(l.source));
const LF = window.LlmFamilies;
const gens = plate => (N(plate).generations || []).map(N).filter(g => g && !g.retired);

// Namesake dates
const suvorov = N("p-alexander-suvorov");
check("Alexander Suvorov loses the general's dates", suvorov.born == null && suvorov.died == null && suvorov.country == null, JSON.stringify([suvorov.born, suvorov.died]));
check("the reason is kept", /rules the dates out|from the page/.test(suvorov.factsDropped || ""), suvorov.factsDropped);
const semple = N("p-tom-semple");
check("Tom Semple, a hurler's page, loses his dates", semple.born == null && semple.died == null);
const sayer = DATA.nodes.find(n => n.type === "person" && n.label === "Malcolm Sayer");
check("a person with an article of their own keeps it", sayer && sayer.born == 1916 && !sayer.factsDropped, sayer && sayer.born);
const kept = DATA.nodes.find(n => n.id === "p-john-beltz");
check("a looked-up page naming the make keeps its dates", !kept || (kept.born != null && !kept.factsDropped), kept && kept.born);
const general = "{{Infobox military person | name = Alexander Suvorov}} '''Alexander Vasilyevich Suvorov''' was a Russian general.";
check("a page naming none of the makes is not theirs", LF.personPageIsTheirs(general, ["Hyundai"]) === false);
check("a page naming the make is", LF.personPageIsTheirs("He designed cars for [[Hyundai Motor Company]] in Namyang.", ["Hyundai"]) === true);
check("a make must be a whole word", LF.personPageIsTheirs("A Kiama native.", ["Kia"]) === false);
check("a list of namesakes is no one's", LF.personPageIsTheirs("'''Bob Lutz''' may refer to: * Bob Lutz (businessman), Chrysler", ["Chrysler"]) === false);
check("with no make known, any real page will do", LF.personPageIsTheirs(general, []) === true);

// Repeated generations
// The Mitsubishi Express's page is a list of other articles (8 Nov), so its read is not
// replayed; the fold itself is checked on the seven nameplates below.
for (const [plate, re] of [["m-toyota-bz4x", /Pre-facelift/], ["m-austin-bmc-ado17", /Mark I\)/], ["m-morris-cowley", /Bullnose \(1919/],
  ["m-maruti-suzuki-gypsy", /16V/], ["m-bmw-ix3", /NA6/], ["m-cmc-veryca", /Minicab \(Second/], ["fam-honda-hr-v", /third generation/i]]) {
  const hit = gens(plate).filter(g => re.test(g.label));
  check(`${N(plate).label} lists ${re} once`, hit.length === 1, hit.map(g => g.label).join(" | "));
}
const ru = "llm-fam-honda-hr-v-second-generation-ru-";
check("the HR-V's second generation leads to the third that stays",
  DATA.links.some(l => !l.retired && l.type === "gensucc" && idOf(l.source) === ru && idOf(l.target) === "m-honda-hr-v-third-generation"));
check("the third that stays keeps the copy's Civic platform", named("m-honda-hr-v-third-generation").includes("m-honda-civic-eleventh-generation"));
check("different generations of one plate stay apart", gens("m-cmc-veryca").length >= 4, gens("m-cmc-veryca").length);

// The Lincoln Marks: one car each, numbered as generations by the Mark series article
const marks = gens("m-lincoln-mark-series").map(g => g.label.replace("Mark series ", ""));
check("the Mark series keeps Mark II to Mark VII", ["Mark II", "Mark III", "Mark IV", "Mark V", "Mark VI", "Mark VII"].every(m => marks.includes(m)), marks.join(", "));
for (const id of ["llm-related-continental-mark-iii", "m-lincoln-continental-mark-iv", "m-lincoln-continental-mark-v",
  "m-lincoln-continental-mark-vi", "m-lincoln-continental-mark-vii", "m-ford-continental-mark-ii"]) {
  check(`${N(id).label} folds into its Mark series generation`, N(id).retired && /^llm-m-lincoln-mark-series-mark-/.test(N(id).supersededBy || ""), N(id).supersededBy);
}
const mkr = N("m-lincoln-mkr");
check("the MKR is one 2007 car", mkr.type === "model" && !mkr.retired && mkr.year === 2007, `${mkr.type} ${mkr.year}`);
check("the MKR keeps its designers", named("m-lincoln-mkr", "designed").includes("p-j-mays"), named("m-lincoln-mkr", "designed").join());
check("the Mark IV has the 385 V8 its page names", named("llm-m-lincoln-mark-series-mark-iv", "fitted").some(id => /385/.test(N(id).label)));
check("the Mark VII has the BMW diesel its page names", named("llm-m-lincoln-mark-series-mark-vii", "fitted").some(id => /M21/.test(N(id).label)));

check("the Mark VIII is the Mark series' seventh generation", N("m-lincoln-mark-viii").supersededBy === "llm-m-lincoln-mark-series-mark-viii" &&
  N("llm-m-lincoln-mark-series-mark-viii").familyOf === "m-lincoln-mark-series" && !N("llm-m-lincoln-mark-series-mark-viii").retired);
check("the Mark VIII keeps its Modular V8", named("llm-m-lincoln-mark-series-mark-viii", "fitted").some(id => /Modular/.test(N(id).label)));
check("the Mark VIII keeps the Thunderbird it shared a platform with", named("llm-m-lincoln-mark-series-mark-viii").includes("m-ford-thunderbird-tenth-generation"));

// Generation photos
const photo = id => N(id).wikiFile || "";
check("the Mark III shows a Mark III", /Mark III/.test(photo("llm-m-lincoln-mark-series-mark-iii")), photo("llm-m-lincoln-mark-series-mark-iii"));
check("the Mark IV shows a Mark IV", /Mark IV/.test(photo("llm-m-lincoln-mark-series-mark-iv")), photo("llm-m-lincoln-mark-series-mark-iv"));
check("the Mark V shows a Mark V", /Mark V\b/.test(photo("llm-m-lincoln-mark-series-mark-v")), photo("llm-m-lincoln-mark-series-mark-v"));
const cards = "{{Infobox automobile\n| name = Continental Mark II\n| image = Mark II.jpg\n| successor = [[Continental Mark III]]\n}}\n" +
  "{{Infobox automobile\n| name = Continental Mark III\n| image = Mark III.jpg\n| predecessor = [[Continental Mark II]]\n}}";
check("a card's successor field does not name it", LF.findGenerationImage(cards, "Mark III", -1, new Set(), 0) === "Mark III.jpg",
  LF.findGenerationImage(cards, "Mark III", -1, new Set(), 0));
const twoHeadings = "==Bullnose and Flatnose engines==\n[[File:Engine.jpg]]\n==Flatnose (1926–1931)==\n{{Infobox automobile\n| image = 1927 Cowley.jpg\n}}\n";
check("the heading with the code's years is its section", LF.findGenerationImage(twoHeadings, "Flatnose (1926–1931)", -1, new Set(), 0) === "1927 Cowley.jpg",
  LF.findGenerationImage(twoHeadings, "Flatnose (1926–1931)", -1, new Set(), 0));

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
