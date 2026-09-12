// Real user report: "try to understand why exactly the thumbnail picture
// doesn't match properly with the car, specifically when the picture is for a
// particular generation of a nameplate. See if the local LLM can better be
// pointed to the proper section of the Wikipedia page where that generation is
// listed, like where the info card of that generation exists in the Wikipedia,
// is also where the picture for that generation likely lives."
//
// The diagnosis, from the real Mercedes-Benz GLA and CLA articles (every one
// of their six generations had NO picture at all in llm_families.json): a
// nameplate does not have to give its generations headings. The GLA writes
// each generation as a bold chassis code followed immediately by its own
// {{Infobox automobile}}, and its only headings are sub-sections INSIDE those
// generations -- "Facelift", "GLA 45 AMG", "Technical details". So
// sectionRangeForCode finds nothing for "X156" and both heading-based tiers
// are skipped. And the article contains not one [[File:...]] link -- all four
// photos are infobox `image =` parameters -- so every later tier had nothing
// to scan either.
//
// Fixture mirrors that structure exactly, including the "(X 156)" spacing
// Wikipedia captions use for a code the graph stores as "X156".
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { url: "http://localhost:8077/", runScripts: "outside-only" });
const w = dom.window;
global.window = w; global.document = w.document;
w.LLM_FAMILIES = { __serverAvailable: false, families: {} };
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
w.fetch = async () => { throw new Error("no article should be fetched in this test"); };
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;

const pad = (label, n) => ("\n" + (label + " filler. ").repeat(n) + "\n");

// No generation headings anywhere; three infoboxes; zero [[File:]] links.
const GLA = [
  "{{Infobox automobile",
  "| name = Mercedes-Benz GLA",
  "| image = Mercedes-Benz GLA 250 e AMG Line (H 247) front.jpg",
  "| manufacturer = Mercedes-Benz",
  "}}",
  "The '''Mercedes-Benz GLA''' is a subcompact crossover.",
  pad("lead", 40),
  "'''X156'''",
  "{{Infobox automobile",
  "| name = Mercedes-Benz GLA (X156)",
  "| image = Mercedes-Benz GLA 200 CDI Urban (X 156) front.jpg",
  "}}",
  pad("first generation body", 60),
  "=== Facelift ===",
  pad("facelift body", 20),
  "=== GLA 45 AMG ===",
  pad("amg body", 20),
  "'''H247'''",
  "{{Infobox automobile",
  "| name = Mercedes-Benz GLA (H247)",
  "| image = Mercedes-Benz H247 IMG 3397.jpg",
  "}}",
  pad("second generation body", 60),
  "=== 2023 facelift ===",
  pad("facelift body", 20),
  "== Sales ==",
  pad("sales", 10),
].join("\n");

const anchor = code => LF.codeAnchorIn(GLA.toLowerCase(), code);

{
  const used = new Set();
  const x156 = LF.findGenerationImage(GLA, "X156", anchor("X156"), used, 0);
  used.add(String(x156).toLowerCase());
  const h247 = LF.findGenerationImage(GLA, "H247", anchor("H247"), used, 0);

  t("a generation with no heading still finds its own infobox photo",
    x156 === "Mercedes-Benz GLA 200 CDI Urban (X 156) front.jpg", x156);
  t("...and so does the next one, not the same photo again",
    h247 === "Mercedes-Benz H247 IMG 3397.jpg", h247);
  t("the two generations do not share a photo", x156 !== h247);
  t("neither takes the article's lead image",
    x156 !== "Mercedes-Benz GLA 250 e AMG Line (H 247) front.jpg" &&
    h247 !== "Mercedes-Benz GLA 250 e AMG Line (H 247) front.jpg");
}

// The naming half, reached when the code has no usable anchor: "(X 156)" in a
// caption must still match the stored "X156".
t("a code is matched across the spacing Wikipedia writes it with",
  LF.infoboxImageForCode(GLA, "X156", -1, new Set()) ===
  "Mercedes-Benz GLA 200 CDI Urban (X 156) front.jpg",
  LF.infoboxImageForCode(GLA, "X156", -1, new Set()));

// A generation whose own infobox carries no image must not reach forward and
// claim a LATER generation's card. (Falling back to a lead image that names
// the same generation is fine -- that is still a photo of this car -- so this
// fixture gives the lead a neutral filename to isolate the real risk.)
const NOIMG = [
  "{{Infobox automobile\n| name = Test GLA\n| image = Test GLA front three quarter.jpg\n}}",
  pad("lead", 40),
  "'''H247'''",
  "{{Infobox automobile\n| name = Test GLA (H247)\n| image = \n| caption = \n}}",
  pad("second generation body", 60),
  "'''H248'''",
  "{{Infobox automobile\n| name = Test GLA (H248)\n| image = H248 only photo.jpg\n}}",
  pad("third generation body", 40),
].join("\n");
const noimgResult = LF.infoboxImageForCode(NOIMG, "H247", NOIMG.toLowerCase().indexOf("h247"), new Set());
t("a generation whose own infobox has no image does not steal a later one's",
  noimgResult !== "H248 only photo.jpg", noimgResult);

// The heading-based path that already worked must keep working, and keep
// winning over the positional one.
const HEADED = [
  "{{Infobox automobile\n| name = Test\n| image = Lead photo.jpg\n}}",
  "== First generation (W460) ==",
  "{{Infobox automobile\n| name = W460\n| image = W460 photo.jpg\n}}",
  pad("w460", 30),
  "== Second generation (W463) ==",
  "{{Infobox automobile\n| name = W463\n| image = W463 photo.jpg\n}}",
  pad("w463", 30),
].join("\n");
t("a headed article still resolves through its section, unchanged",
  LF.findGenerationImage(HEADED, "W463", HEADED.toLowerCase().indexOf("w463"), new Set(), 0) === "W463 photo.jpg",
  LF.findGenerationImage(HEADED, "W463", HEADED.toLowerCase().indexOf("w463"), new Set(), 0));

// Non-photographic infobox images stay excluded everywhere.
const LOGO = "{{Infobox automobile\n| name = X\n| image = Brand logo.svg\n}}\n'''Q1'''\n{{Infobox automobile\n| image = Marque emblem.png\n}}\n";
t("logos and emblems are still never used as a thumbnail",
  LF.infoboxImageForCode(LOGO, "Q1", LOGO.indexOf("Q1"), new Set()) === null);

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
