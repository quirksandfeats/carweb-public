// A generation's section names a car by its name, not by a sibling's code or place (8 Nov 2026).
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
const byLabel = (make, label) => DATA.nodes.find(n => !n.retired && n.make === make && n.label === label);
const plateGen = (make, plate, label) => { const p = byLabel(make, plate); return p && DATA.nodes.find(n => !n.retired && n.familyOf === p.id && (n.label === label || n.label === plate + " " + label)); };
function idOf(v) { return typeof v === "string" ? v : v && v.id; }
const pairs = (a, b) => !!a && !!b && DATA.links.some(l => !l.retired && l.type === "platform" &&
  ((idOf(l.source) === a.id && idOf(l.target) === b.id) || (idOf(l.source) === b.id && idOf(l.target) === a.id)));
const g = (m, p, l) => plateGen(m, p, l);
check("a section naming the Celica (A60) does not pair the Carina A60 with the Celica T160",
  !pairs(g("Toyota", "Celica", "T160"), g("Toyota", "Carina", "A60")));
check("the Capella GD goes with the Telstar AT/AV, not the AX/AY",
  pairs(g("Mazda", "Capella", "GD/GV"), g("Ford", "Telstar", "Second generation (AT, AV)")) &&
  !pairs(g("Mazda", "Capella", "GD/GV"), g("Ford", "Telstar", "Third generation (AX, AY)")));
check("the Capella GD goes with the MX-6 GD, not the GE",
  pairs(g("Mazda", "Capella", "GD/GV"), g("Mazda", "MX-6", "GD")) && !pairs(g("Mazda", "Capella", "GD/GV"), g("Mazda", "MX-6", "GE")));
check("the Fox Mustang goes with the Fox-era Cougar, not the 1971 one",
  pairs(byLabel("Ford", "Mustang (Fox)"), g("Mercury", "Cougar", "Sixth generation")) &&
  !pairs(byLabel("Ford", "Mustang (Fox)"), g("Mercury", "Cougar", "Second generation")));
check("a place the nameplate's own labels do not carry decides nothing: the Swift RS keeps the Dzire",
  pairs(g("Suzuki", "Swift", "RS"), g("Suzuki", "Dzire", "Second generation (2011)")));
check("a place two lines share names those lines: the 1993 Ranger keeps the UN105 Explorer",
  pairs(g("Ford", "Ranger", "Second generation (1993)"), g("Ford", "Explorer", "UN105/UN150")));
check("a series numeral is not read as a generation: the Oxford VI keeps the 16/60",
  pairs(g("Morris", "Oxford", "Series VI"), g("Wolseley", "15/60", "Wolseley 16/60")));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
