// A succession drawn both ways goes the way the articles state it (9 Nov 2026).
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
function idOf(v) { return typeof v === "string" ? v : v && v.id; }
const live = (a, b, type) => DATA.links.filter(l => !l.retired && l.type === (type || "succession") && idOf(l.source) === a && idOf(l.target) === b);
check("the list of article-stated directions is loaded", Object.keys(window.SUCCESSION_DIRECTIONS || {}).length >= 40);
check("both ways where both articles say so: Taurus -> Five Hundred -> Taurus",
  live("fam-ford-taurus", "m-ford-five-hundred").length > 0 && live("m-ford-five-hundred", "fam-ford-taurus").length > 0);
check("the Five Hundred hands over to the fifth-generation Taurus", live("m-ford-five-hundred", "m-ford-taurus-fifth-generation").length > 0);
const dartNeon = live("m-dodge-dart-pf", "fam-chrysler-neon").concat(live("m-dodge-dart-pf", "m-chrysler-neon"));
check("the Dart (PF) is succeeded by the Neon, as its article says, for Mexico",
  dartNeon.length > 0 && dartNeon.every(l => l.region === "Mexico"), dartNeon.map(l => l.region).join(","));
check("and not the other way", live("fam-chrysler-neon", "m-dodge-dart-pf").length === 0 && live("m-chrysler-neon", "m-dodge-dart-pf").length === 0);
check("a car and its own generation: no Falcon <-> Falcon (EL) succession",
  live("fam-ford-falcon", "m-ford-falcon-el").length === 0 && live("m-ford-falcon-el", "fam-ford-falcon").length === 0);
check("a succession no article states goes: HR-V <-> Crosstour",
  !DATA.links.some(l => !l.retired && l.type === "succession" && [idOf(l.source), idOf(l.target)].sort().join("|") === ["fam-honda-hr-v", "m-honda-crosstour"].sort().join("|")));
const is10 = DATA.nodes.find(n => !n.retired && n.make === "Lexus" && n.label === "IS XE10"), is20 = DATA.nodes.find(n => !n.retired && n.make === "Lexus" && n.label === "IS (XE20)");
check("the IS XE20 no longer 'succeeds' into the XE10; the chain stays", is10 && is20 && live(is20.id, is10.id).length === 0 && live(is10.id, is20.id, "gensucc").length === 1);
const mk2 = DATA.nodes.find(n => !n.retired && n.make === "Lincoln" && n.label === "Mark series Mark II");
const c3 = DATA.nodes.find(n => !n.retired && n.make === "Lincoln" && n.label === "Continental Third generation");
check("an article's own generation pair is drawn: Continental Mark II -> the 1958 Continental", mk2 && c3 && live(mk2.id, c3.id).length > 0);
const dart = DATA.nodes.find(n => n.id === "m-dodge-dart-pf");
window.CarWeb.openDetail(dart);
const rows = [...window.document.querySelectorAll("#detail .dt-conn")].map(b => b.textContent);
check("the Dart's card says the Neon succeeded it in Mexico", rows.some(t => /Neon/.test(t) && /\(Mexico\)/.test(t)), rows.filter(t => /Neon/.test(t)).join(" | "));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
