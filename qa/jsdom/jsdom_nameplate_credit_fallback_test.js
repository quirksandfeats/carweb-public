// Real user report, on the Buick Invicta: "I see who drew them in the info
// card but not a link."
//
// linkInLayer hides a family-level designed/engineered line while that family
// is EXPANDED, so the more specific generation-level line wins instead of both
// drawing at once. That rests on "every family mirrors its generations'
// designed/engineered links up to itself" -- true of a build-time family, and
// NOT true of a nameplate the LLM has just split: its designers came from
// DBpedia's article about the nameplate and were never attributed to any one
// generation, so the minted generations carry designers: []. Hiding the
// family line left the card listing two designers with no line anywhere.
//
// The user's own call: "that's fine to fall back on linking the designer
// directly to the nameplate instead of the generation." So the specific line
// still wins when it exists, and otherwise the credit stays drawn on the
// nameplate.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

// NAMEPLATE-ONLY credit: the Invicta's shape. Two generations, neither
// credited, one designer known only at the nameplate level.
// GENERATION credit: the build-time shape. The family mirrors a credit its
// generation also carries directly.
const MK = "mk-testcredit";
function seed(DATA) {
  DATA.nodes.push({ id: MK, type: "make", label: "TestCredit", year: 1950 });
  const person = id => ({ id, type: "person", kind: "person", label: id.slice(2),
                          roles: ["designer"], born: 1920, died: null, country: null, wp: null });
  DATA.nodes.push(person("p-nameplate-only"), person("p-also-on-gen"));

  const gen = (id, fam, year) => ({ id, type: "model", label: id, make: "TestCredit",
    year, end: year + 3, familyOf: fam, designers: [], engineers: [] });

  // family A -- credit lives only on the nameplate
  DATA.nodes.push({ id: "fam-a", type: "family", label: "Invicta-like", make: "TestCredit",
    year: 1959, end: 1963, designers: ["nameplate-only"], engineers: [], generations: ["m-a-g1", "m-a-g2"] });
  DATA.nodes.push(gen("m-a-g1", "fam-a", 1959), gen("m-a-g2", "fam-a", 1961));
  DATA.links.push({ source: "fam-a", target: MK, type: "made" },
                  { source: "fam-a", target: "m-a-g1", type: "generation" },
                  { source: "fam-a", target: "m-a-g2", type: "generation" },
                  { source: "fam-a", target: "p-nameplate-only", type: "designed" });

  // family B -- the family line is a mirror of a real generation-level line
  DATA.nodes.push({ id: "fam-b", type: "family", label: "GClass-like", make: "TestCredit",
    year: 1979, end: null, designers: ["also-on-gen"], engineers: [], generations: ["m-b-g1"] });
  const bg = gen("m-b-g1", "fam-b", 1979);
  bg.designers = ["also-on-gen"];
  DATA.nodes.push(bg);
  DATA.links.push({ source: "fam-b", target: MK, type: "made" },
                  { source: "fam-b", target: "m-b-g1", type: "generation" },
                  { source: "fam-b", target: "p-also-on-gen", type: "designed" },
                  { source: "m-b-g1", target: "p-also-on-gen", type: "designed" });
}

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const loadScript = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
loadScript("d3.min.js");
loadScript("data.js");
seed(window.CARDATA);
window.LLM_FAMILIES = { families: {}, relations: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

const cw = window.CarWeb;
cw.boot();
cw.setLayer("designers");
cw.setYearRange(1900, 2030);

const famLink = id => cw.links.find(l => l.type === "designed" &&
  (l.source.id || l.source) === id);

// collapsed: unchanged, the family line is the only one that can draw
t("collapsed, a nameplate-only credit draws", cw.linkInLayer(famLink("fam-a")) === true);
t("collapsed, a mirrored credit draws too", cw.linkInLayer(famLink("fam-b")) === true);

cw.expandFamily("fam-a");
cw.expandFamily("fam-b");

t("expanded, a credit no generation carries STAYS on the nameplate",
  cw.linkInLayer(famLink("fam-a")) === true);
t("expanded, a credit a generation does carry is hidden in its favour",
  cw.linkInLayer(famLink("fam-b")) === false);
t("...and that generation's own line is the one drawing",
  cw.linkInLayer(cw.links.find(l => l.type === "designed" &&
    (l.source.id || l.source) === "m-b-g1")) === true);

// The card and the canvas must agree: the whole bug was the card listing a
// designer the graph refused to draw.
cw.openDetail(cw.byId.get("fam-a"));
const card = window.document.getElementById("detail").textContent;
t("the card still lists the nameplate-level designer", /nameplate-only/.test(card));
t("...and now something on the canvas backs that up",
  cw.linkInLayer(famLink("fam-a")) === true);

cw.collapseFamily("fam-a");
t("collapsing again changes nothing", cw.linkInLayer(famLink("fam-a")) === true);

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
