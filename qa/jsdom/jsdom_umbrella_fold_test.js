// Real user report: "the mercedes c class scan does not automatically check
// that there already exist generations for its nameplate ... the generations
// are already currently listed but they do not get merged into one nameplate
// either."
//
// The graph held the C-Class twice: a nameplate "C" built from the W202-W206
// articles, and the umbrella "Mercedes-Benz C-Class" article as a plain car.
// Same page ("Mercedes-Benz C" redirects to it), different names, so the
// name-based duplicate pass never paired them, and a check on the plain car
// deferred to the nameplate and stopped.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
const fakeCtx = () => new Proxy({ measureText: () => ({ width: 10 }) },
  { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1; window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const add = (n, mk) => { D.nodes.push(Object.assign({ designers: [], engineers: [] }, n));
      if (mk) D.links.push({ source: n.id, target: mk, type: "made" }); };
    add({ id: "mk-t-zb", type: "make", label: "Zetabenz", year: 1926 });
    add({ id: "fam-t-c", type: "family", label: "C", make: "Zetabenz", year: 1993, generations: ["g-t-c1", "g-t-c2"] }, "mk-t-zb");
    add({ id: "g-t-c1", type: "model", label: "C-Class (W202)", make: "Zetabenz", familyOf: "fam-t-c", wp: "Zetabenz C-Class (W202)", year: 1993, end: 2000 });
    add({ id: "g-t-c2", type: "model", label: "C-Class (W203)", make: "Zetabenz", familyOf: "fam-t-c", wp: "Zetabenz C-Class (W203)", year: 2000, end: 2007 });
    D.links.push({ source: "fam-t-c", target: "g-t-c1", type: "generation" }, { source: "fam-t-c", target: "g-t-c2", type: "generation" });
    // the overview article, as a plain car, with a credit of its own
    add({ id: "m-t-c-class", type: "model", label: "C-Class", make: "Zetabenz", wp: "Zetabenz C-Class", year: 1993, designers: ["Test Designer"] }, "mk-t-zb");
    // one generation that happens to carry the nameplate's article
    add({ id: "m-t-c-w205", type: "model", label: "C-Class (W205)", make: "Zetabenz", wp: "Zetabenz C-Class", year: 2014 }, "mk-t-zb");
    // a nameplate whose overview car is an EARLIER era than its generations
    add({ id: "fam-t-v", type: "family", label: "V", make: "Zetabenz", year: 2005, generations: ["g-t-v1"] }, "mk-t-zb");
    add({ id: "g-t-v1", type: "model", label: "V (A1)", make: "Zetabenz", familyOf: "fam-t-v", wp: "Zetabenz V (A1)", year: 2005 });
    D.links.push({ source: "fam-t-v", target: "g-t-v1", type: "generation" });
    add({ id: "m-t-v-class", type: "model", label: "V-Class", make: "Zetabenz", wp: "Zetabenz V-Class", year: 1972, end: 1973 }, "mk-t-zb");
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false,
      wpRedirects: { "Zetabenz C": "Zetabenz C-Class", "Zetabenz V": "Zetabenz V-Class" } };
  }
  window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
}
const cw = window.CarWeb; cw.boot();
const fam = cw.byId.get("fam-t-c"), plain = cw.byId.get("m-t-c-class");
check("the plain car whose article is the nameplate's own is folded into it",
      plain.retired && plain.supersededBy === "fam-t-c", JSON.stringify({ retired: plain.retired, to: plain.supersededBy }));
check("...and the nameplate takes the article's name", fam.label === "C-Class", fam.label);
check("...keeps its generations", fam.generations.length === 2, fam.generations.length);
check("...and gets the plain car's credits", (fam.designers || []).includes("Test Designer"));
check("a generation carrying the nameplate's article is not taken for the overview",
      !cw.byId.get("m-t-c-w205").retired);
check("an overview car from an earlier era than the nameplate's generations is left alone",
      !cw.byId.get("m-t-v-class").retired);
console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
process.exit(fails ? 1 : 0);
