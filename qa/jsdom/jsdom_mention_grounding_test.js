// What the article says about a mention, and which generation it says it of. Each
// case is one a real scan got wrong, in a short copy of the article's own wording.
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
store.settings.reviewedV = 11;
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") w.LLM_FAMILIES = Object.assign({}, store, { __serverAvailable: false });
  ev(f);
}
w.CarWeb.boot();
const LF = w.LlmFamilies;
const nodes = w.CARDATA.nodes, links = w.CARDATA.links;
const by = id => nodes.find(n => n.id === id);
const idOf = v => (typeof v === "string" ? v : v.id);
const linked = (a, b) => links.some(l => l.type === "platform" && !l.retired && [idOf(l.source), idOf(l.target)].sort().join("|") === [a, b].sort().join("|"));
const gen = (code, sharedPlatforms, yearStart, yearEnd) => ({ code, sharedPlatforms, yearStart: yearStart || null, yearEnd: yearEnd === undefined ? null : yearEnd });

// ---------- a rival is no relation ----------
const GLAS = `The Glas 1700 competed directly with BMW's own BMW 1800 which was already being produced.
Glas could not compete on level terms with the Opel Rekord or the BMW 1800/2000.
These cars were branded as the BMW 1800 GL and BMW 2000GL.
They were rebadged as the BMW 1804 and BMW 2004.`;
let g = [gen("Glas 1700", ["BMW 1800", "BMW 1804", "BMW 2004"])];
LF.dropRivalMentions(g, GLAS);
t("the BMW 1800, named only as a rival, goes", !g[0].sharedPlatforms.includes("BMW 1800"));
t("the BMW 1800 GL does not count as naming it", g[0].sharedPlatforms.length === 2, g[0].sharedPlatforms.join());
g = [gen("A", ["BMW 1800"])];
LF.dropRivalMentions(g, GLAS + "\nThe BMW 1800 shares its doors with this car.");
t("one other sentence naming it keeps it", g[0].sharedPlatforms.length === 1);
g = [gen("A", ["Plymouth Savoy"])];
LF.dropRivalMentions(g, "The Diplomat models were an alternative to the Plymouth Savoy, essentially the same vehicle.");
t("an alternative that is the same vehicle stays", g[0].sharedPlatforms.length === 1);
g = [gen("A", ["Ford Elite"])];
LF.dropRivalMentions(g, "As a continuation of the Ford Elite, it was to better compete in the market of the Grand Prix.");
t("a rival word after the name is about something else", g[0].sharedPlatforms.length === 1);
g = [gen("A", ["Toyota Alphard"])];
LF.dropRivalMentions(g, "| related = [[Toyota Alphard]]\nThe main competitors are the Toyota Alphard and the Honda Odyssey.");
t("the infobox naming it keeps it", g[0].sharedPlatforms.length === 1);

// ---------- the section says which generation ----------
const SECTIONS = `Lead.\n\n==W460==\nMade under licence as the Peugeot P4.\n\n==W463==\nA new body.\n\n==W464==\nAnother.\n\n==Racing==\nIt raced the Lada Niva.\n\n==References==\n`;
g = [gen("W460", ["Peugeot P4"]), gen("W463", ["Peugeot P4"]), gen("W464", [])];
LF.placeMentionsBySection(g, SECTIONS);
t("a name only the W460's section gives leaves the W463", g[0].sharedPlatforms.length === 1 && !g[1].sharedPlatforms.length);
g = [gen("W460", []), gen("W463", ["Peugeot P4"]), gen("W464", [])];
LF.placeMentionsBySection(g, SECTIONS);
t("and moves there rather than leave the car", g[0].sharedPlatforms[0] === "Peugeot P4" && !g[1].sharedPlatforms.length);
g = [gen("W460", ["Lada Niva"]), gen("W463", ["Lada Niva"])];
LF.placeMentionsBySection(g, SECTIONS);
t("a name in a section of no generation stays", g[0].sharedPlatforms.length === 1 && g[1].sharedPlatforms.length === 1);
g = [gen("W463", ["Fiat Campagnola"]), gen("W464", [])];
LF.placeMentionsBySection(g, SECTIONS);
t("a name no section gives stays", g[0].sharedPlatforms.length === 1);
g = [gen("W460", ["Toyota Land Cruiser (W463)"]), gen("W463", ["Toyota Land Cruiser (W463)"])];
LF.placeMentionsBySection(g, SECTIONS.replace("A new body.", "Beside the Toyota Land Cruiser."));
t("a mention tagged with a generation stays on it", g[1].sharedPlatforms.length === 1);
g = [gen("W460", ["W463"]), gen("W463", ["W460"])];
LF.placeMentionsBySection(g, SECTIONS);
t("a sibling's own name is left alone", g[0].sharedPlatforms[0] === "W463" && g[1].sharedPlatforms[0] === "W460");

// ---------- the lead speaks for the whole car, unless one list was spread ----------
const LIST = ["Dodge Dart", "Dodge 440", "Plymouth Fury"];
const PHOENIX = `{{Infobox automobile\n| related = [[Dodge Dart]]<br>[[Dodge 440]]<br>[[Plymouth Fury]]\n}}\nBased on the Dodge Dart, later the Dodge 440, then the Plymouth Fury.\n\n==History==\n===RD4===\nRestyled in line with the 1961 Dodge Dart.\n===VD2===\nBased on the Dodge 440.\n===AP2D===\nA rebadged Plymouth Fury.\n===DB6===\nFollows the Fury III.\n===DC===\nA new grille.\n===DD===\nThe Fury again.\n\n==References==\n`;
g = [gen("RD4", []), gen("VD2", []), ...["AP2D", "DB6", "DC", "DD"].map(c => gen(c, [...LIST]))];
LF.placeMentionsBySection(g, PHOENIX);
t("a spread list loses what the sections give others", g.slice(2).every(x => !x.sharedPlatforms.includes("Dodge Dart") && !x.sharedPlatforms.includes("Dodge 440")));
t("those go to the sections that give them", g[0].sharedPlatforms[0] === "Dodge Dart" && g[1].sharedPlatforms[0] === "Dodge 440", JSON.stringify(g.slice(0, 2)));
t("what half the group's sections give stays on all of it", g.slice(2).every(x => x.sharedPlatforms.includes("Plymouth Fury")), JSON.stringify(g[4]));
g = [gen("RD4", []), gen("VD2", []), gen("AP2D", ["Dodge Dart"]), gen("DC", [])];
LF.placeMentionsBySection(g, PHOENIX);
t("one generation with a lead's name keeps it", g[2].sharedPlatforms[0] === "Dodge Dart");

// ---------- a page read beside the article speaks for its generation ----------
const MAIN = `Lead.\n\n==Sixth generation (S550)==\nOn the D2C.\n\n==Seventh generation (S650)==\nNew.\n\n==Mustang Mach-E==\nAn electric crossover.\n\n==References==\n`;
const PAGE = `The Mach-E shares the C2 platform of the Ford Focus (fourth generation).`;
const whole = MAIN + "\n\n" + PAGE;
const pages = [{ title: "Ford Mustang Mach-E", at: MAIN.length + 2, stop: whole.length }];
g = [gen("Sixth generation (S550)", ["Ford Focus (fourth generation)"]), gen("Seventh generation (S650)", []), gen("Mustang Mach-E", ["Ford Focus (fourth generation)"])];
LF.placeMentionsBySection(g, whole, pages);
t("the Mach-E's page does not speak for the S550", !g[0].sharedPlatforms.length);
t("it does for the Mach-E", g[2].sharedPlatforms.length === 1);
g = [gen("Sixth generation (S550)", ["Ford Focus (fourth generation)"]), gen("Seventh generation (S650)", []), gen("Mustang Mach-E", [])];
LF.placeMentionsBySection(g, whole);
t("with no page known, the text stays where the model put it", g[0].sharedPlatforms.length === 1);

// ---------- a generation's own card settles its end ----------
const card = (h, range, extra) => `==${h}==\n{{Infobox automobile\n| production = ${range}\n${extra || ""}}}\nText.\n\n`;
const ended = (code, start, end, text) => { const x = [gen(code, [], start, end), gen("Other", [], 1990, 1995)]; LF.endYearsFromOwnCards(x, "Lead.\n\n" + text + "==Other==\nText.\n"); return x[0].yearEnd; };
t("the card's end replaces the read's", ended("First", 1964, 1974, card("First", "1964–1967")) === 1967);
t("a card saying present does not reopen a car that ended", ended("First", 2019, 2025, card("First", "2019–present")) === 2025);
t("a heading giving the read's end leaves the read", ended("Mexico", 1981, 1988, card("Mexico (1981–1988)", "1981–1982")) === 1988);
t("a production field that is no plain range leaves the read", ended("First", 1999, 2005, card("First", "{{ubl|1999–2005 (Japan)}}", "| model_years = 1999–2006\n")) === 2005);
t("months in a card are read", ended("First", 2003, 2010, card("First", "October 2003–August 2012")) === 2012);
t("another start leaves the read", ended("First", 1978, 1980, card("First", "1977–1981")) === 1980);
t("several ranges leave the read", ended("First", 1990, 1994, card("First", "1990–1994<br>1994–2009 (Kancil)")) === 1994);
t("a market in brackets leaves the read", ended("First", 1990, 1994, card("First", "1990–2009 (Malaysia)")) === 1994);
t("no card leaves the read", ended("First", 1980, 1983, "==First==\nProduced 1980 to 1989.\n\n") === 1983);
t("agreeing with model years leaves the read", ended("First", 1977, 1989, card("First", "1977–1988", "| model_years = 1977–1989\n")) === 1989);

// ---------- a validated read has all of it ----------
const raw = { hasMultipleGenerations: true, generations: [
  { code: "W460", yearStart: 1979, yearEnd: 1990, designers: [], engineers: [], sharedPlatforms: ["Peugeot P4"] },
  { code: "W463", yearStart: 1990, yearEnd: 1999, designers: [], engineers: [], sharedPlatforms: ["Peugeot P4", "Lada Niva"] }] };
const article = `Lead.\n\n==W460==\n{{Infobox automobile\n| production = 1979–1991\n}}\nAs the Peugeot P4.\n\n==W463==\nFrom 1990 and 1999.\n\n==Rivals==\nIts rivals were the Lada Niva.\n`;
const clean = LF.__validateForTest(raw, article);
t("validate places mentions", !clean.generations[1].sharedPlatforms.includes("Peugeot P4"));
t("validate drops rivals", !clean.generations[1].sharedPlatforms.includes("Lada Niva"));
t("validate reads the card", clean.generations[0].yearEnd === 1991, clean.generations[0].yearEnd);

// ---------- a bare name's page ----------
t("the article on a year is no car's", !LF.barePageIsThisCar("{{Infobox year}}\n'''2004''' was a leap year.", "BMW"));
t("nor a country that shares the letters", !LF.barePageIsThisCar("{{Infobox country}}\nThe Republic of Artsakh.", "Chevrolet"));
t("nor another maker's car", !LF.barePageIsThisCar("{{Infobox automobile\n| name = Rover P6\n}}\nThe Rover P6 is a car.", "NSU"));
t("a car page naming the make is", LF.barePageIsThisCar("{{Infobox automobile\n| name = Jeep CJ\n| manufacturer = Willys\n}}", "Willys"));
const src = fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8");
t("the year lookup asks that of the bare name", /fetchYearFactsGrounded\(modelLabel, makeLabel\)/.test(src));

// ---------- the closest name ----------
const lab = (id, label) => ({ id, label });
const paired = LF.pairFreshGenerations([lab("a", "Dodge Dart 440"), lab("b", "Dodge 440")], [{ code: "440" }]);
t("the 440 pairs with the Dodge 440", paired[0] && paired[0].id === "b", paired[0] && paired[0].id);

// ---------- a maker and a place ----------
const before = nodes.length, l0 = links.length;
t("Chrysler Australia is no car", LF.mintRelatedNode(nodes, links, "Chrysler Australia") === null);
t("Ford Brazil is no car", LF.mintRelatedNode(nodes, links, "Ford Brazil") === null);
t("Unheardof Europe makes no make", LF.mintRelatedNode(nodes, links, "Unheardof Europe") === null && nodes.length === before && links.length === l0);
t("the Austin America is", !!LF.mintRelatedNode(nodes, links, "Austin America"));
t("the Maserati Mexico is", !!LF.mintRelatedNode(nodes, links, "Maserati Mexico"));

// ---------- what the Glas 1700's scan and its like put on the shipped store ----------
const f = id => by("llm-related-bmw-" + id);
t("the 1800SA runs 1968 to 1973", f("1800sa").year === 1968 && f("1800sa").end === 1973);
t("the 1804 runs 1973 to 1974", f("1804").year === 1973 && f("1804").end === 1974 && f("1804").wp === "Glas 1700");
t("the 2004 is not a car of 2004", f("2004").year === 1973 && f("2004").end === 1974 && f("2004").wp === "Glas 1700");
t("the South African cars stay on the Glas", ["1800sa", "1804", "2004"].every(x => linked("llm-related-bmw-" + x, "m-glas-1700")));
t("BMW's own 1800 does not", !f("1800") && !linked("llm-related-bmw-1800", "m-glas-1700"));
t("the New Class keeps its sedan", !!by("llm-m-bmw-new-class-bmw-new-class-sedan"));
for (const id of ["fiat-grand-raid", "willys-m606", "xinkai-camry", "sanjiu-vitara", "renault-univers", "chevrolet-nkr", "bedford-nkr", "nsu-p6", "nsu-p10", "fiat-mini", "gm-m-body", "isuzu-dragon-power"]) {
  const n = by("llm-related-" + id);
  t(`${id} has no borrowed years`, !n || (n.year == null && n.end == null), n && n.year);
}
t("the Acadian's right years stay", by("llm-related-acadian-automobile").year === 1962);
t("a 305 has no rivals for platforms", !linked("m-peugeot-305", "m-ford-cortina") && !linked("m-peugeot-305", "m-renault-12") && !linked("m-peugeot-305", "m-ford-taunus"));
t("the Challenger is not on the Camaro", !linked("llm-llm-related-dodge-challenger-third-generation-2008-2023", "m-chevrolet-camaro"));
t("the Transit Custom stays on the Transporter", linked("llm-related-ford-transit-custom", "fam-volkswagen-transporter"));
t("the big Transit does not", !linked("llm-related-ford-transit", "fam-volkswagen-transporter"));
t("the Diplomat stays on the Savoy", linked("llm-m-plymouth-savoy-third-generation", "m-desoto-diplomat"));
t("the Elite stays on the Thunderbird", linked("m-ford-elite", "m-ford-thunderbird-seventh-generation"));

// ---------- end years the generations' own infoboxes give, on the shipped store ----------
t("the Genesis BH ends in 2013", by("llm-m-hyundai-genesis-bh").end === 2013);
t("the Sonata YF ends in 2014", by("llm-llm-related-hyundai-sonata-yf").end === 2014);
t("the Move L600 ends in 1998", by("llm-m-daihatsu-move-l600").end === 1998);
t("the Kadett's last year follows", by("m-opel-kadett").end === 1995);
t("the Galaxy has ended", by("m-ford-galaxy").end === 2023);
t("the A8 D5 sits with the A6 C8", linked("llm-m-audi-a6-c8", "llm-m-audi-a8-d5") && !linked("llm-m-audi-a6-c7", "llm-m-audi-a8-d5"));
t("the 442 is off the first GTO", !linked("llm-m-oldsmobile-442-second-generation", "llm-llm-related-pontiac-gto-first-generation-1964-1967"));
// Left out, because the years would move these links wrongly.
t("the Innova AN140 stays with the Fortuner beside it", linked("llm-m-toyota-fortuner-second-generation-an150-an160", "llm-m-toyota-innova-an140"));
t("and with the Hilux beside it", linked("llm-m-toyota-hilux-an110-an120-an130", "llm-m-toyota-innova-an140"));
t("the K9 RJ stays on the G80 DH", linked("llm-m-genesis-g80-dh", "llm-m-kia-k9-rj"));
t("the Tracker stays on the Vitara FT", linked("llm-m-chevrolet-tracker-americas-second-generation", "llm-m-suzuki-vitara-second-generation-ft-gt"));
t("the 4Runner N180 stays off the Hilux N80", !linked("llm-m-toyota-4runner-n180", "llm-m-toyota-hilux-n80-n90-n100-n110-n200"));
t("the K9 KH is not on the Genesis DH", !linked("llm-m-hyundai-genesis-dh", "llm-m-kia-k9-kh"));
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
