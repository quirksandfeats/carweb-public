// What the check of the Dodge Dart (PF) scan's cascade corrected, on the shipped store.
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
store.settings.reviewedV = 10;
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") w.LLM_FAMILIES = Object.assign({}, store, { __serverAvailable: false });
  ev(f);
}
w.CarWeb.boot();
const nodes = w.CARDATA.nodes, links = w.CARDATA.links;
const by = id => nodes.find(n => n.id === id);
const idOf = v => (typeof v === "string" ? v : v.id);
const linked = (a, b) => links.some(l => l.type === "platform" && !l.retired && [idOf(l.source), idOf(l.target)].sort().join("|") === [a, b].sort().join("|"));
t("the S550 does not share the Focus's platform", !linked("m-ford-mustang-sixth-generation", "m-ford-focus-fourth-generation"));
t("nor does the Mustang nameplate", !linked("fam-ford-mustang", "fam-ford-focus"));
t("the Mach-E does", linked("m-ford-mustang-mach-e", "m-ford-focus-fourth-generation"));
const ends = { PD4: 1960, RD4: 1961, SD2: 1962, TD2: 1963, VD2: 1964, AP2D: 1965, DB6: 1966, DC: 1967, DD: 1968, DE: 1970, DF: 1971, DG: 1971, DH: 1972 };
for (const [code, end] of Object.entries(ends)) {
  const g = by("llm-m-dodge-phoenix-" + code.toLowerCase());
  t(`Phoenix ${code} ends in ${end}`, g && g.end === end, g && g.end);
}
const dart = by("llm-m-dodge-440-dodge-dart-440"), plain = by("llm-m-dodge-440-dodge-440");
t("the Dart 440 is a 1962 car", dart.year === 1962 && dart.end === 1962, dart.end);
t("the 440 keeps 1963 to 1964", plain.year === 1963 && plain.end === 1964, plain.end);
const phoenix = code => "llm-m-dodge-phoenix-" + code;
t("a Fury-based Phoenix keeps its Fury", linked(phoenix("ap2d"), "llm-m-plymouth-fury-fourth-generation") && linked(phoenix("de"), "llm-m-plymouth-fury-fifth-generation"));
for (const code of ["ap2d", "db6", "dc", "dd", "de", "df", "dg", "dh"]) {
  const wrong = links.filter(l => l.type === "platform" && [idOf(l.source), idOf(l.target)].includes(phoenix(code)) &&
    /^(?:llm-)?m-dodge-(?:dart|440)(?:-|$)/.test(idOf(l.source) === phoenix(code) ? idOf(l.target) : idOf(l.source)));
  t(`the ${code} is on neither the Dart nor the 440`, !wrong.length, wrong.length);
}
t("the SD2 is on the Dart", linked(phoenix("sd2"), "llm-m-dodge-dart-second-generation"));
t("the TD2 and VD2 are on the 440", linked(phoenix("td2"), "llm-m-dodge-440-dodge-440") && linked(phoenix("vd2"), "llm-m-dodge-440-dodge-440"));
console.log(fails ? fails + " failed" : "all passed");
process.exit(fails ? 1 : 0);
