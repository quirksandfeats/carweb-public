// Three more from the same batch.
//
// A. THE AUDI NUVOLARI. The check returned
//      {"hasMultipleGenerations": false, "generations":[{..., "designers":["Massimo Frascella"], ...}]}
//    and the Designers layer showed nothing for the car. "Whenever I do an LLM
//    search, I want that the information about the designers and engineers
//    also be added to the database."
//
//    applyConfirmed is the only thing that mints person nodes out of a check
//    result, and it opens with `if (entry.status !== "confirmed") return;`
//    followed by `if (gens.length < 2) return;`. A car with exactly ONE
//    generation is recorded as status "none" -- there's no split to confirm --
//    so it failed BOTH guards and every designer found on it was discarded.
//    applySharedPlatformForSingleGen already existed to close exactly this
//    hole for the platform half of a "none" verdict; applyPeopleForSingleGen
//    is its twin for the people half.
//
// B. DUPLICATE ROWS. "SHARES PLATFORM WITH: ... Volkswagen Tiguan 2007,
//    Volkswagen Tiguan 2007 ... Notice that the Tiguan 2007 is listed twice.
//    It only needs to be listed once."
//
//    Two independent causes, both fixed: mirrorRelationLinks keyed an
//    UNDIRECTED relation source-first, so an existing `terramar|tiguan` link
//    didn't match the `tiguan|terramar` mirror about to be derived and a
//    second link was added; and the card lists one row per LINK while the
//    canvas draws one line per PAIR, so it had no equivalent of linkInLayer's
//    mirror-vs-real precedence.
//
// C. THE DISMISS BUTTON. "Have the 'dismiss' 'x' button be to the left of the
//    description of the match, like a bullet point. That way, I can simply
//    hover my mouse on one location and as I continue dismissing the messages
//    I won't have to move my mouse to the end of the text."
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
const idOf = x => (typeof x === "string" ? x : (x && x.id));

function freshWindow(opts) {
  opts = opts || {};
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window;
  global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  load("d3.min.js");
  load("data.js");
  if (opts.seed) opts.seed(window.CARDATA);
  window.LLM_FAMILIES = Object.assign({ families: {}, relations: {}, recheck: {} }, opts.llmSeed || {});
  load("llm_families.js");
  load("app.js");
  load("timeline.js");
  load("sixdeg.js");
  return window;
}

// ============ A. the Audi Nuvolari ============
console.log("--- a designer found on a ONE-generation car reaches the graph ---");
{
  const window = freshWindow({
    seed(DATA) {
      DATA.nodes.push({ id: "mk-audi-t", type: "make", label: "AudiT", year: 1909 },
        { id: "m-audi-nuvolari", type: "model", label: "Nuvolari", make: "AudiT",
          wp: "Audi Nuvolari quattro", year: 2027, end: null });
      DATA.links.push({ source: "m-audi-nuvolari", target: "mk-audi-t", type: "made" });
    },
    llmSeed: {
      // Exactly the reported result shape: hasMultipleGenerations false, ONE
      // generation entry, a real designer on it. status "none" is what a
      // single-generation verdict is recorded as.
      families: {
        "m-audi-nuvolari": {
          status: "none", sourceTitle: "Audi Nuvolari quattro",
          proposal: { hasMultipleGenerations: false, generations: [{
            code: "Audi Nuvolari", yearStart: 2027, yearEnd: null,
            designers: ["Massimo Frascella"], engineers: ["Test Engineer"],
            sharedPlatforms: [],
          }] },
        },
      },
    },
  });
  const cw = window.CarWeb;
  cw.boot();

  const person = cw.nodes.find(n => n.type === "person" && n.label === "Massimo Frascella");
  check("the designer now exists as a person node at all (was: silently dropped)", !!person,
    person ? person.id : "not found");
  check("...and is tagged as a designer", !!person && (person.roles || []).includes("designer"),
    person ? JSON.stringify(person.roles) : "-");

  const car = cw.byId.get("m-audi-nuvolari");
  check("the car itself lists the designer", (car.designers || []).includes("Massimo Frascella"),
    JSON.stringify(car.designers));
  const link = cw.links.find(l => l.type === "designed" &&
    ((idOf(l.source) === "m-audi-nuvolari" && idOf(l.target) === (person || {}).id) ||
     (idOf(l.target) === "m-audi-nuvolari" && idOf(l.source) === (person || {}).id)));
  check("a real designed link connects them (this is what the Designers layer draws)", !!link);
  check("...and it survives the Designers layer filter",
    !!link && cw.linkInLayer(link) !== false);

  // The engineer half too -- same code path, and just as easy to leave out.
  const eng = cw.nodes.find(n => n.type === "person" && n.label === "Test Engineer");
  check("the engineer was credited as well", !!eng && (eng.roles || []).includes("engineer"));

  // Idempotence matters: this runs at boot AND after every live check, so a
  // second pass must not double-credit anyone.
  const before = cw.links.filter(l => l.type === "designed" && idOf(l.source) === "m-audi-nuvolari").length;
  window.LlmFamilies.applyPeopleForSingleGen(cw.nodes, cw.links);
  window.LlmFamilies.applyPeopleForSingleGen(cw.nodes, cw.links);
  const after = cw.links.filter(l => l.type === "designed" && idOf(l.source) === "m-audi-nuvolari").length;
  check("running it again credits nobody twice", before === after, `${before} -> ${after}`);
  check("...and the name list stays clean too",
    (cw.byId.get("m-audi-nuvolari").designers || []).filter(d => d === "Massimo Frascella").length === 1);
}

// ============ B. one car, one row ============
console.log("\n--- the shared-platform list never repeats a car ---");
{
  // The reported shape, minimally: a nameplate with two generations, one of
  // which has a real generation-level platform link to another car, AND an
  // existing nameplate-level link between the same two cars stored in the
  // OPPOSITE direction. That direction is the entire bug.
  const window = freshWindow({
    seed(DATA) {
      DATA.nodes.push({ id: "mk-vwt", type: "make", label: "VWT", year: 1937 },
        { id: "fam-vwt-tiguan", type: "family", label: "Tiguan", make: "VWT", year: 2007, end: null,
          generations: ["g-vwt-ad1", "g-vwt-ct1"] },
        { id: "g-vwt-ad1", type: "model", label: "Tiguan AD1/AX1", make: "VWT", familyOf: "fam-vwt-tiguan", year: 2016, end: 2024 },
        { id: "g-vwt-ct1", type: "model", label: "Tiguan CT1", make: "VWT", familyOf: "fam-vwt-tiguan", year: 2024, end: null },
        { id: "mk-cupra-t", type: "make", label: "CupraT", year: 2018 },
        { id: "m-cupra-terramar-t", type: "model", label: "Terramar", make: "CupraT", year: 2024, end: null });
      DATA.links.push(
        { source: "fam-vwt-tiguan", target: "mk-vwt", type: "made" },
        { source: "m-cupra-terramar-t", target: "mk-cupra-t", type: "made" },
        // Stored Terramar -> Tiguan...
        { source: "m-cupra-terramar-t", target: "fam-vwt-tiguan", type: "platform" },
        // ...while the generation-level fact would derive Tiguan -> Terramar.
        { source: "g-vwt-ad1", target: "m-cupra-terramar-t", type: "platform" });
    },
  });
  const cw = window.CarWeb;
  cw.boot();

  const famLevel = cw.links.filter(l => l.type === "platform" && !l.retired &&
    [idOf(l.source), idOf(l.target)].sort().join("|") === ["fam-vwt-tiguan", "m-cupra-terramar-t"].sort().join("|"));
  check("only ONE family-level link between the pair, not two (this was the bug)",
    famLevel.length === 1, famLevel.length + " links");

  // ...and the card itself, driven through the real openDetail.
  cw.setYearRange(1900, cw.yearRange().max);
  cw.openDetail(cw.byId.get("m-cupra-terramar-t"));
  const detail = window.document.getElementById("detail");
  const heads = [...detail.querySelectorAll(".dt-connections h4")];
  const platHead = heads.find(h => /shares platform with/i.test(h.textContent));
  check("the card has a shared-platform section", !!platHead);
  const rows = [];
  if (platHead) {
    let el = platHead.nextElementSibling;
    while (el && el.tagName !== "H4") { rows.push(el.textContent.trim()); el = el.nextElementSibling; }
  }
  const counts = rows.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {});
  const repeated = Object.keys(counts).filter(k => counts[k] > 1);
  check("no car is listed twice on the card", repeated.length === 0,
    repeated.length ? JSON.stringify(repeated) : JSON.stringify(rows));

  // Belt and braces: even if something re-introduces a duplicate link, the
  // card must still show the car once.
  cw.links.push({ source: "m-cupra-terramar-t", target: "fam-vwt-tiguan", type: "platform", sn: cw.byId.get("m-cupra-terramar-t"), tn: cw.byId.get("fam-vwt-tiguan") });
  (cw.adj.get("m-cupra-terramar-t") || []).push({ n: cw.byId.get("fam-vwt-tiguan"), l: cw.links[cw.links.length - 1] });
  cw.openDetail(cw.byId.get("m-cupra-terramar-t"));
  const heads2 = [...detail.querySelectorAll(".dt-connections h4")];
  const platHead2 = heads2.find(h => /shares platform with/i.test(h.textContent));
  const rows2 = [];
  if (platHead2) {
    let el = platHead2.nextElementSibling;
    while (el && el.tagName !== "H4") { rows2.push(el.textContent.trim()); el = el.nextElementSibling; }
  }
  const counts2 = rows2.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {});
  check("a deliberately duplicated link STILL renders one row",
    Object.keys(counts2).every(k => counts2[k] === 1), JSON.stringify(rows2));

  // Succession is directional and must not be collapsed by the same key.
  const LF = window.LlmFamilies;
  const nodes = cw.nodes, links = cw.links;
  const n0 = links.length;
  links.push({ source: "g-vwt-ad1", target: "m-cupra-terramar-t", type: "succession" });
  LF.applyResolvedRelations(nodes, links);
  const succ = links.filter(l => l.type === "succession" && l.mirror &&
    idOf(l.source) === "fam-vwt-tiguan" && idOf(l.target) === "m-cupra-terramar-t");
  check("succession still mirrors (direction is part of that fact, not noise)",
    succ.length === 1, succ.length + "");
}

// ============ C. the dismiss button leads the row ============
console.log("\n--- the dismiss X comes first, like a bullet ---");
{
  const src = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
  // Every message that offers a dismiss must put the button before its text,
  // so the target lands in the same place on every row.
  const lines = src.split("\n").filter(l => l.includes("llmCloseBtn(key)"));
  check("there are dismissable messages to check", lines.length >= 5, lines.length + "");
  const trailing = lines.filter(l => {
    const at = l.indexOf("llmCloseBtn(key)");
    const after = l.slice(at + "llmCloseBtn(key)".length);
    // Anything other than closing markup after the button means text follows
    // it -- i.e. the button is still at the end of the description.
    return !/^[`}\s]*(<\/(div|span)>)?[`;,\s]*$/.test(after) === false;
  });
  const stillTrailing = lines.filter(l => {
    const at = l.indexOf("llmCloseBtn(key)");
    const before = l.slice(0, at);
    // The button should be the first thing inside its container.
    return !/(>|`|\$\{)\s*$/.test(before);
  });
  check("no message still renders the button after its text",
    stillTrailing.length === 0, stillTrailing.map(l => l.trim().slice(0, 60)).join(" | "));
  void trailing;

  const css = fs.readFileSync(path.join(APP, "styles.css"), "utf-8");
  const rule = (css.match(/\.llm-close\{[^}]*\}/) || [""])[0];
  check("the button floats left so the text wraps beside it", /float:\s*left/.test(rule), rule.slice(0, 80));
  check("...at a fixed width, so it's in the same spot on every row",
    /width:\s*\d+px/.test(rule), rule.slice(0, 120));
  check("the float is contained so rows can't ride up into each other",
    /\.llm-status[^{]*\{[^}]*overflow:\s*hidden/.test(css));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
