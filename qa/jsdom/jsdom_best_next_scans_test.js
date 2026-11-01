// The status report's list of which cars to queue next. Follows the hops a
// requested scan takes, ranks by what each adds beyond the ones above it, and
// counts only cars with no answer on file.
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
w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = w; global.document = w.document;
const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
ev("d3.min.js"); ev("data.js");
const read = { status: "none" };
w.LLM_FAMILIES = { families: { hub: read, a1: read, gate: { status: "rejected" }, "fam": read }, recheck: { fam2: read }, relations: {}, __serverAvailable: false };
ev("llm_families.js"); ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
w.CarWeb.boot();
const LF = w.LlmFamilies;
const m = (id, extra) => Object.assign({ id, type: "model", label: id, make: "T" }, extra);
const nodes = [
  m("hub"), m("a1"), m("n1"), m("n2"), m("n3"), m("n4"), m("far"), m("gate"), m("behind"), m("lone"),
  { id: "fam", type: "family", label: "fam", make: "T", generations: ["g1", "g2"] }, m("g1", { familyOf: "fam" }), m("g2", { familyOf: "fam" }),
  { id: "fam2", type: "family", label: "fam2", make: "T", generations: [] }, m("old", { retired: true, supersededBy: "n4" }),
  m("x1"), m("x2"), { id: "e1", type: "engine", label: "e1" },
];
const link = (source, target, type) => ({ source, target, type: type || "platform" });
const links = [
  link("hub", "n1"), link("hub", "n2", "succession"), link("n2", "n3", "related"),
  link("hub", "g1"), link("g2", "fam2"), link("fam2", "old"),
  link("hub", "gate"), link("gate", "behind"),
  link("hub", "e1", "fitted"), link("e1", "lone", "fitted"),
  link("x1", "x2"), link("a1", "x1"), { source: "hub", target: "far", type: "platform", retired: true },
];
const r = LF.bestNextScans(nodes, links, { depth: 7 });
const first = r.picks[0], second = r.picks[1];
t("the car reaching the most new cars comes first", first && first.newCars === 4 + 0 && first.alone === 4, JSON.stringify(first));
t("a nameplate and its generations are one stop, and links go through to its neighbours", first.reads >= 7, first.reads);
t("what it reads includes cars already read", first.reads > first.newCars);
t("the next one counts only what the first did not reach", second && second.newCars === 2, JSON.stringify(second));
t("a retired link, a declined split and an engine are not hops", !r.picks.some(p => p.alone > 4));
t("unread cars with no live connection are counted as unconnected", r.unconnected === 2, r.unconnected);
const near = LF.bestNextScans(nodes, links, { depth: 1 });
t("the level limits the hops", near.picks[0].alone < 4, JSON.stringify(near.picks[0]));
t("the list stops at five", LF.bestNextScans(nodes, links).picks.length <= 5);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
