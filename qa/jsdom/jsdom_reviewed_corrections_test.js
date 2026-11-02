// The corrections from the review of 2 Nov 2026: lists a re-read cannot put right
// are written once, as answers, and a generation with its own article is named
// after it. Everything else about these cars is decided as usual.
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
const gen = (code, yearStart, yearEnd, designers) => ({ code, yearStart, yearEnd, designers: designers || [], engineers: [], sharedPlatforms: [] });
const WILL = "llm-related-toyota-will-vs", VI = "llm-related-toyota-will-vi", GEN_VI = "llm-" + WILL + "-will-vi", GEN_VS = "llm-" + WILL + "-will-vs";
const key = (a, b, type) => [a, b].sort().join("|") + "|" + type;
const SPRING_PIXO = "llm-llm-related-dacia-spring-second-generation-b1325|llm-llm-related-nissan-pixo-ev-renault-twingo-e-tech|platform";
const KEY_VI = key(GEN_VI, "m-toyota-vitz", "platform"), KEY_DROPPED = key("llm-" + WILL + "-gone", "m-toyota-vitz", "platform");
const rel = (a, b, genA) => ({ status: "confirmed", relType: "platform", famA: a, famB: b, genIdA: genA, genIdB: b });
const split = (title, gens) => ({ status: "confirmed", sourceTitle: title, proposal: { hasMultipleGenerations: true, generations: gens } });
w.LLM_FAMILIES = { settings: {}, rejectedRelations: {}, renames: {}, userCars: {}, wpLinks: {}, mintedFacts: {},
  wpLinksChosen: {},
  recheck: { "fam-honda-cr-v": { status: "none", sourceTitle: "Honda CR-V" }, "llm-related-dacia-spring-second-generation": { status: "error", error: "no wikitext" },
    "fam-holden-caprice": { status: "none", sourceTitle: "Holden Caprice" }, "fam-tesla-roadster": { status: "none", sourceTitle: "Tesla Roadster (first generation)" } },
  families: { [WILL]: split("WiLL", [gen("WiLL Vi", 2000, 2001, ["Jim Shimizu"]), gen("WiLL VS", 2001, 2004, ["Hiroo Ono"]), gen("WiLL Cypha", 2002, 2005)]),
    "m-studebaker-avanti": split("Studebaker Avanti", [gen("Avanti II", 1965, 1986), gen("Avanti", 1987, 2006)]),
    "llm-related-mazda-bongo-brawny": split("Mazda Bongo", [gen("First generation", 1966, 1975), gen("Bongo Brawny", 1983, 2010)]),
    "llm-related-jeep-dj-5": split("Jeep DJ", [gen("DJ-3A", 1955, 1965), gen("DJ-5", 1965, 1967)]),
    "llm-related-dacia-spring-second-generation": split("Dacia Spring", [gen("BBG", 2021, 2026), gen("B1325", 2027, null)]),
    "llm-related-nissan-pixo-ev": split("Nissan Pixo", [gen("Suzuki Alto", 2009, 2013), gen("Renault Twingo E-Tech", 2026, null)]) },
  relations: { [KEY_VI]: rel(WILL, "m-toyota-vitz", GEN_VI), [KEY_DROPPED]: rel(WILL, "m-toyota-vitz", "llm-" + WILL + "-gone"),
    [key("llm-fam-honda-cr-v-rs", "m-honda-element", "platform")]: rel("fam-honda-cr-v", "m-honda-element", "llm-fam-honda-cr-v-rs"),
    [SPRING_PIXO]: Object.assign(rel("llm-related-dacia-spring-second-generation", "llm-related-nissan-pixo-ev", "llm-llm-related-dacia-spring-second-generation-b1325"), { genIdB: "llm-llm-related-nissan-pixo-ev-renault-twingo-e-tech", reworkPending: { kind: "remove", reason: "no longer mentions" } }) },
  __serverAvailable: false };
const minted = (id, make, label) => ({ id, type: "model", make, label, year: 2000, end: null, wp: label });
w.CARDATA.nodes.push({ id: "mk-testar", type: "make", label: "TestAr" }, minted(WILL, "Toyota", "WiLL VS"),
  minted("llm-related-mazda-bongo-brawny", "Mazda", "Bongo Brawny"), minted("llm-related-dacia-spring-second-generation", "Dacia", "Spring (second generation)"), minted("llm-related-nissan-pixo-ev", "Nissan", "Pixo EV"), minted("llm-related-jeep-dj-5", "Jeep", "DJ-5"),
  { id: "f-rd", type: "family", label: "RD", make: "TestAr", generations: ["g-rd2", "g-rd3"] },
  { id: "g-rd2", type: "model", label: "RD", make: "TestAr", year: 2000, end: 2007, wp: "TestAr RD (second generation)", familyOf: "f-rd" },
  { id: "g-rd3", type: "model", label: "RD (third generation)", make: "TestAr", year: 2007, end: 2013, wp: "TestAr RD (third generation)", familyOf: "f-rd" },
  { id: "f-kp", type: "family", label: "KP", make: "TestAr", wp: "TestAr KP", generations: ["g-kp1", "g-kp2"] },
  { id: "g-kp1", type: "model", label: "KP", make: "TestAr", year: 1990, end: 2000, wp: "TestAr KP", familyOf: "f-kp" },
  { id: "g-kp2", type: "model", label: "KP (2000)", make: "TestAr", year: 2000, end: 2010, wp: "TestAr KP (2000)", familyOf: "f-kp" });
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies, S = w.LLM_FAMILIES, nodes = w.CarWeb.nodes;
const by = id => nodes.find(n => n.id === id);
t("a brand page's first car stands alone, with its own credits", S.families[VI].status === "none" && S.families[VI].proposal.generations[0].designers[0] === "Jim Shimizu");
t("...on every boot, with its years", S.userCars[VI] && S.userCars[VI].year === 2000 && by(VI) && by(VI).year === 2000 && by(VI).end === 2001, JSON.stringify(by(VI) && [by(VI).year, by(VI).end]));
t("the nameplate is one car again", S.families[WILL].status === "none" && S.families[WILL].proposal.generations[0].code === "WiLL VS", S.families[WILL].status);
t("...and is not offered as a user car", !S.userCars[WILL]);
t("...with no generations", by(WILL) ? !(by(WILL).generations || []).length : true);
t("a relationship on a generation moves to the car it became", !S.relations[KEY_VI] && S.relations[key(VI, "m-toyota-vitz", "platform")] && S.relations[key(VI, "m-toyota-vitz", "platform")].genIdA === VI);
t("one on a generation with no car stays where it was", !!S.relations[KEY_DROPPED]);
t("a list the model reads as series is written as generations", S.recheck["fam-holden-caprice"].status === "applied" && S.recheck["fam-holden-caprice"].proposal.generations.length === 4);
t("the Avanti's list has the car its article is about", S.recheck["m-studebaker-avanti"].proposal.generations[0].yearStart === 1962);
t("a nameplate with nothing on file is left alone", !S.renames["llm-related-isuzu-journey-j"]);
t("the nameplates minted under a version take their article's name", S.renames["llm-related-mazda-bongo-brawny"].label === "Bongo" && S.renames["llm-related-jeep-dj-5"].label === "DJ");
t("...and the version keeps its own", S.renames["llm-llm-related-jeep-dj-5-dj-5"].label === "DJ-5");
t("a nameplate whose own title is a disambiguation page keeps its article", S.wpLinks["fam-tesla-roadster"] === "Tesla Roadster (first generation)");
// Once: a later scan's answer is not written over.
S.recheck["fam-holden-caprice"].status = "none";
LF.applyReviewedCorrections();
t("written once, so a later answer stands", S.recheck["fam-holden-caprice"].status === "none");
// The second review.
t("the CR-V's generation with an article is back in its list", S.recheck["fam-honda-cr-v"].proposal.generations.some(g => g.code === "RS / ZC8") && !S.recheck["fam-honda-cr-v"].proposal.generations.some(g => g.code === "RS"));
t("...and what was resolved for its stray entry moves to it", !!S.relations[key("m-honda-cr-v-sixth-generation", "m-honda-element", "platform")]);
t("a nameplate whose page was deleted keeps what was read, under a page that exists", S.wpLinks["llm-related-dacia-spring-second-generation"] === "Dacia Spring (electric car)" && S.wpLinksChosen["llm-related-dacia-spring-second-generation"] === true);
t("...its failed re-read no longer waits", (S.recheck["llm-related-dacia-spring-second-generation"] || {}).status !== "error");
t("...and the name that was never the car's goes", S.renames["llm-related-dacia-spring-second-generation"].label === "Spring");
t("the flag behind that deleted page is cleared", !S.relations[SPRING_PIXO].reworkPending);
t("the Pixo's nameplate takes the article's name", S.renames["llm-related-nissan-pixo-ev"].label === "Pixo");
t("...and its second car says what it is", S.renames["llm-llm-related-nissan-pixo-ev-renault-twingo-e-tech"].label === "Pixo EV (Renault Twingo E-Tech-based)");
// Named after its own article, at load.
t("a generation named like its nameplate takes the generation its article is", by("g-rd2").label === "RD (second generation)", by("g-rd2").label);
t("...and the nameplate then reads its own overview", by("f-rd").wp === "TestAr RD", by("f-rd").wp);
t("...a generation on the nameplate's article keeps its name", by("g-kp1").label === "KP", by("g-kp1").label);
t("the rule leaves a name with no 'generation' in its article alone", by("g-kp2").label === "KP (2000)");
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
