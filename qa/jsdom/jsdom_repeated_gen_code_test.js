// Real bug report, on the Mercedes-Benz G-Class. The card showed:
//
//   G-Class W460   1979–1991
//   G-Class W461   1985–2022
//   G-Class W463   2018–2024      <- wrong years; this is the 1990–2018 car
//   G-Class W463A  2018–2022
//   G-Class W463   2018–2024      <- the same entry again
//   G-Class W464   2022–2024
//   G-Class W465   2024–
//
// "Notice that the W463 is mentioned twice. This is because the LLM found two
//  entries of the W463, but didn't read the full label. There was a W463 first
//  generation and a second generation. Additionally, when expanding the G Class
//  nameplate, I see all of the generations, but only one W463 generation. The
//  other W463 lies outside of the generation link, and is its own node by
//  itself, not connected to the existing graph."
//
// Wikipedia's own article is the reason this is hard: it has a section headed
// "W463" and a later one headed "Second generation W463 (2018–present)", and
// says outright that Mercedes "has not explained the reason for retaining the
// same chassis designation". W463A, meanwhile, is not a Mercedes designation at
// all -- it's what some sources call the 2018 car to tell it apart.
//
// So two opposite behaviours are needed, and both are asserted below:
//   * W463A over the SAME years as W463 is one car listed twice -> merge
//   * W463 (1990–2018) vs W463 (2018–) is two real generations -> keep both,
//     tell them apart, and above all never give them the same node id (that
//     collision is what produced the orphaned node)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
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

// A stand-in for the real article: two sections sharing one code, plus the
// unofficial variant spelling, plus a licensed rebadge named only in prose.
const WIKITEXT = `
{{Infobox automobile
| name = TestGee-Class
| manufacturer = TestBenz
| production = 1979–present
}}
The TestGee-Class was also sold under the TestPuch name as TestPuch G until 2000,
and a variant made under licence in France, the TestPug P4, used a TestPug engine.

== W460 ==
{{Infobox automobile
| name = W460
| image = testgee w460 infobox.jpg
| caption = A W460
| production = 1979–1991
}}
[[File:testgee w460 stray.jpg|thumb|An unrelated shot in the same section]]
The W460 ran from 1979 to 1991.

== W461 ==
{{Infobox automobile
| name = W461
| image = testgee w461 infobox.jpg
| caption = TestGee-Class G 280 CDI EDITION.30 PUR
| production = 1985–2022 (military variant)
}}
[[File:testgee w461 stray.jpg|thumb|An unrelated shot]]
The W461 replaced the W460 in 1991 and ran until 2022. A 1985 study preceded it.

== W463 ==
{{Infobox automobile
| name = W463
| image = testgee w463 first infobox.jpg
| production = 1990–2018
}}
The W463 was produced from 1990 to 2018. Variants included the G 63 AMG and the
G 500 4x4², which are not separate generations.

== Second generation W463 (2018–present) ==
{{Infobox automobile
| name = W463 (2018)
| image = testgee w463 second infobox.jpg
| production = 2018–present
}}
Some sources unofficially designate this model W463A. TestBenz has not explained
retaining the same chassis designation, W463.

== W464 (2022–present) ==
[[File:testgee w464.jpg|thumb|The W464]]
The W464 is a new variation of the W461 for military use.

== Gallery ==
[[File:testgee logo.svg|thumb|A logo, never a thumbnail]]
`;

function freshWindow(withApp, seedData, seedStore) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  if (seedData) seedData(window.CARDATA);
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, __serverAvailable: true }, seedStore || {});
  load("llm_families.js");
  if (withApp) { load("app.js"); load("timeline.js"); load("sixdeg.js"); }
  return window;
}

// What the local model actually returned for the G-Class, in the same order.
const RAW = {
  hasMultipleGenerations: true,
  generations: [
    { code: "W460", yearStart: 1979, yearEnd: 1991, designers: [], engineers: [], sharedPlatforms: [] },
    { code: "W461", yearStart: 1985, yearEnd: 2022, designers: [], engineers: [], sharedPlatforms: [] },
    { code: "W463", yearStart: 1990, yearEnd: 2018, designers: [], engineers: [], sharedPlatforms: [] },
    { code: "W463A", yearStart: 2018, yearEnd: 2022, designers: [], engineers: [], sharedPlatforms: [] },
    { code: "W463", yearStart: 2018, yearEnd: 2024, designers: [], engineers: [], sharedPlatforms: [] },
    { code: "W464", yearStart: 2022, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] },
  ],
};

console.log("--- what comes out of validation ---");
const window = freshWindow();
const clean = window.LlmFamilies.__validateForTest(RAW, WIKITEXT);
const codes = clean.generations.map(g => g.code);
console.log("   codes:", JSON.stringify(codes));

check("the W463A duplicate is folded into the 2018 W463",
  !codes.some(c => /463a/i.test(c)), JSON.stringify(codes));
check("...keeping the alternative spelling on record rather than losing it",
  clean.generations.some(g => (g.alsoCoded || []).some(c => /463A/i.test(c))),
  JSON.stringify(clean.generations.map(g => g.alsoCoded)));
check("BOTH real W463 generations survive", codes.filter(c => /w463/i.test(c)).length === 2, JSON.stringify(codes));
check("...and are told apart by their start year",
  codes.includes("W463 (1990)") && codes.includes("W463 (2018)"), JSON.stringify(codes));
const first = clean.generations.find(g => g.code === "W463 (1990)");
const second = clean.generations.find(g => g.code === "W463 (2018)");
check("the 28-year first-generation W463 keeps its own years",
  first && first.yearStart === 1990 && first.yearEnd === 2018,
  first && `${first.yearStart}-${first.yearEnd}`);
check("...and the second keeps its own", second && second.yearStart === 2018, second && second.yearStart);
check("each of the two gets its OWN photo, not one shared between them",
  first && second && first.wikiFile && second.wikiFile && first.wikiFile !== second.wikiFile,
  JSON.stringify([first && first.wikiFile, second && second.wikiFile]));

// Real user request, with a screenshot of the W461 side-card: "there are
// clearly thumbnails of the specific generations present within the overview
// description of each of the generations... which the llm could take from the
// wikipedia page and pass it as the picture of that said generation."
console.log("\n--- each generation takes the photo from its OWN infobox ---");
const fileFor = c => (clean.generations.find(g => g.code === c) || {}).wikiFile;
check("W460 uses its own infobox image, not the stray photo beside it",
  fileFor("W460") === "testgee w460 infobox.jpg", fileFor("W460"));
check("W461 too", fileFor("W461") === "testgee w461 infobox.jpg", fileFor("W461"));
check("the first W463 too", fileFor("W463 (1990)") === "testgee w463 first infobox.jpg", fileFor("W463 (1990)"));
check("...and the second W463 gets the SECOND section's infobox image",
  fileFor("W463 (2018)") === "testgee w463 second infobox.jpg", fileFor("W463 (2018)"));
check("a generation with no infobox still finds its section's photo",
  fileFor("W464") === "testgee w464.jpg", fileFor("W464"));
check("every generation ends up with a photo", clean.generations.every(g => g.wikiFile),
  JSON.stringify(clean.generations.map(g => [g.code, g.wikiFile])));
check("no two generations share one", new Set(clean.generations.map(g => g.wikiFile)).size === clean.generations.length);
check("a logo is never picked as a thumbnail",
  !clean.generations.some(g => /logo|\.svg/i.test(g.wikiFile || "")));
check("the other generations are untouched",
  codes.includes("W460") && codes.includes("W461") && codes.includes("W464"), JSON.stringify(codes));

console.log("\n--- the orphaned node: two generations must never share a node id ---");
{
  const w = freshWindow();
  const LF = w.LlmFamilies;
  const nodes = w.CARDATA.nodes, links = w.CARDATA.links;
  const MK = "mk-test-gee", FAM = "m-test-gee-class";
  nodes.push({ id: MK, type: "make", label: "TestBenz", year: 1926 },
             { id: FAM, type: "model", label: "Gee-Class", make: "TestBenz", year: 1979, end: null, wp: "TestGee-Class" });
  links.push({ source: FAM, target: MK, type: "made" });

  LF.__seedFamilyEntry(FAM, clean, "TestGee-Class");
  LF.applyConfirmed(nodes, links);

  const gens = nodes.filter(n => n.familyOf === FAM);
  const ids = gens.map(n => n.id);
  check("every generation node has a UNIQUE id", new Set(ids).size === ids.length, JSON.stringify(ids));
  check("both W463 generations exist as separate nodes",
    gens.filter(n => /w463/i.test(n.id)).length === 2, JSON.stringify(ids));
  const fam = nodes.find(n => n.id === FAM);
  check("the nameplate lists every one of them", fam.generations.length === gens.length,
    `${fam.generations.length} listed vs ${gens.length} nodes`);
  check("...and every listed id resolves to a real node",
    fam.generations.every(id => nodes.some(n => n.id === id)));
  // The reported symptom: a generation node sitting outside the nameplate with
  // no generation link to it.
  const linked = new Set(links.filter(l => l.type === "generation" &&
    (l.source === FAM || l.target === FAM)).map(l => l.source === FAM ? l.target : l.source));
  check("no generation is left disconnected from the nameplate",
    gens.every(n => linked.has(n.id)), JSON.stringify(gens.filter(n => !linked.has(n.id)).map(n => n.id)));
  const w463s = gens.filter(n => /w463/i.test(n.id));
  check("the two W463 nodes carry different years, not the same ones twice",
    w463s.length === 2 && w463s[0].year !== w463s[1].year,
    JSON.stringify(w463s.map(n => `${n.label} ${n.year}-${n.end}`)));
}

console.log("\n--- a generation with nothing of its own still shows something ---");
(async () => {
// Real user report: "The thumbnails for the individual cars -- particularly
// ones that are nameplates, still don't seem to match the generations it's
// describing. Oftentimes the same picture will be used for each generation,
// which might confuse the user."
{
  const MK = "mk-test-pic", FAM = "m-test-pic-class";
  // Seeded BEFORE boot so the ordinary boot sequence applies it, exactly as a
  // real session would -- calling applyConfirmed by hand and then booting
  // applies it twice.
  const w = freshWindow(true, DATA => {
    DATA.nodes.push({ id: MK, type: "make", label: "PicBenz", year: 1926 },
      { id: FAM, type: "model", label: "Pic-Class", make: "PicBenz", year: 1979, end: null, wp: "TestGee-Class" });
    DATA.links.push({ source: FAM, target: MK, type: "made" });
  }, {
    // Deliberately a proposal where NO generation found a photo of its own --
    // exactly the G-Class situation, where five of seven came back with none.
    families: { [FAM]: { status: "confirmed", checkedAt: "2026-01-01T00:00:00Z", decidedAt: "2026-01-01T00:00:00Z",
      sourceTitle: "TestGee-Class", attempts: 1, feedback: [],
      proposal: { hasMultipleGenerations: true, generations: [
        { code: "AAA", yearStart: 1979, yearEnd: 1991, designers: [], engineers: [], sharedPlatforms: [], wikiFile: null },
        { code: "BBB", yearStart: 1991, yearEnd: 2005, designers: [], engineers: [], sharedPlatforms: [], wikiFile: null },
      ] } } },
  });
  const cw = w.CarWeb;
  cw.boot();
  cw.setYearRange(1900, cw.yearRange().max);
  const gens = cw.nodes.filter(n => n.familyOf === FAM);
  check("(fixture) both generations exist with no photo of their own",
    gens.length === 2 && gens.every(g => !g.wikiFile), gens.length);
  check("...and each inherited the nameplate's article, which is why they all looked alike",
    gens.every(g => g.wp === "TestGee-Class"), JSON.stringify(gens.map(g => g.wp)));

  // Every article answers with a real lead photo, so "did this node end up
  // showing one" is a meaningful question. The extract is still fetched and
  // still shown for a generation -- that text is genuinely useful and isn't
  // what misleads; it's the PICTURE that reads as "this is what this
  // generation looks like" when it isn't.
  w.fetch = (url) => {
    if (/page\/summary/.test(String(url))) {
      return Promise.resolve({ ok: true, json: async () => ({
        thumbnail: { source: "https://example.test/lead.jpg" },
        extract: "An article.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/X" } },
      }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  const shownFor = async id => {
    cw.openDetail(cw.byId.get(id));
    await new Promise(r => setTimeout(r, 20));
    const img = w.document.querySelector("#detail .dt-imgwrap");
    return !!(img && /example\.test/.test(img.style.backgroundImage || ""));
  };
  await (async () => {
      // Andy's correction to a first attempt that showed an empty box here:
    // "it's okay to fall back on whatever picture does exist, even if it
    // doesn't correspond to the correct picture in this case." The real fix
    // is making this case rare (see the infobox tier above), not blanking it.
    check("a generation with no photo of its own falls back to the nameplate's",
      await shownFor(gens[0].id));
    cw.byId.get(gens[1].id).wp = "Pic-Class BBB";
    check("...and a generation with its OWN article shows that article's photo",
      await shownFor(gens[1].id));
    check("...and the nameplate itself is unaffected", await shownFor(FAM));
  })();
}

console.log("\n--- a nameplate whose generations have distinct codes is unaffected ---");
{
  const w = freshWindow();
  const plain = {
    hasMultipleGenerations: true,
    generations: [
      { code: "W460", yearStart: 1979, yearEnd: 1991, designers: [], engineers: [], sharedPlatforms: [] },
      { code: "W461", yearStart: 1991, yearEnd: 2022, designers: [], engineers: [], sharedPlatforms: [] },
    ],
  };
  const out = w.LlmFamilies.__validateForTest(plain, WIKITEXT);
  check("codes are left exactly as they were",
    out.generations.map(g => g.code).join() === "W460,W461", JSON.stringify(out.generations.map(g => g.code)));
}

console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
process.exit(fails ? 1 : 0);
})();
