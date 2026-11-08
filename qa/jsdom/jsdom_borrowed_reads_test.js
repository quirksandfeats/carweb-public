// A car whose title lands on another nameplate's generation page is one car on that generation's platform (app/borrowed_reads.js, 8 Nov 2026).
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
const LF = window.LlmFamilies;
const byId = new Map(DATA.nodes.map(n => [n.id, n]));
const live = id => { const n = byId.get(id); return n && !n.retired ? n : null; };
const pairs = (a, b, type) => DATA.links.some(l => !l.retired && l.type === type &&
  ((idOf(l.source) === a && idOf(l.target) === b) || (idOf(l.source) === b && idOf(l.target) === a)));
function idOf(v) { return typeof v === "string" ? v : v && v.id; }
const BR = window.BORROWED_READS || {};
check("the list of borrowed reads is loaded", Object.keys(BR).length >= 10, Object.keys(BR).length);
const split = Object.keys(BR).filter(id => { const n = live(id); return !n || n.type === "family" || DATA.nodes.some(g => g.familyOf === id && !g.retired); });
check("every listed car is one car, with no generations", split.length === 0, split.join(", "));
const unlinked = Object.keys(BR).filter(id => live(id) && !pairs(id, BR[id].owner, "platform"));
check("every listed car is on its article owner's platform", unlinked.length === 0, unlinked.join(", "));
const lexcen = live("llm-related-toyota-lexcen-t3");
check("the Toyota Lexcen takes the Commodore VR's years", lexcen && lexcen.year === 1993 && lexcen.end === 1995, lexcen && `${lexcen.year}-${lexcen.end}`);
check("no Lexcen generation is named after an HSV", !DATA.nodes.some(n => !n.retired && /^Lexcen HSV/.test(n.label)));
check("the Lexcen keeps the VS Commodore its Opel Calais read named", pairs("m-holden-commodore-vs", "llm-related-toyota-lexcen-t3", "platform"));
check("the Porsche 935 the 930's read named is still there, on the 911 (930)", live("llm-related-porsche-935") && pairs("m-porsche-911-930", "llm-related-porsche-935", "platform"));
check("the Buick Velite 5 is on the second-generation Volt", live("llm-related-buick-velite-5") && pairs("m-chevrolet-volt-second-generation", "llm-related-buick-velite-5", "platform"));
check("the Pontiac Wave's T250 line goes to the Aveo T250, not the T200",
  !pairs("m-chevrolet-aveo-t200", "llm-related-ravon-nexia", "platform"));
// At scan time: a car whose title lands on another nameplate's generation page defers to it.
const plate = { id: "t-fam", type: "family", make: "Holden", label: "Commodore", generations: ["t-vr"] };
const vr = { id: "t-vr", type: "model", make: "Holden", label: "Commodore (VR)", familyOf: "t-fam", wp: "Holden Commodore (VR)" };
const alias = { id: "t-lexcen", type: "model", make: "Toyota", label: "Lexcen", wp: "Holden Commodore (VR)" };
const own = { id: "t-own", type: "model", make: "Holden", label: "Commodore (VR)", wp: "Holden Commodore (VR)" };
const fake = [plate, vr, alias, own];
const got = LF.nodeOwningArticle(fake, "Holden Commodore (VR)", "t-lexcen");
check("a car of another name defers to the generation that owns the page", got && got.id === "t-vr", got && got.id);
const ownGot = LF.nodeOwningArticle(fake, "Holden Commodore (VR)", "t-own");
check("a car of the nameplate's own name is not sent to it", !ownGot || ownGot.id !== "t-vr", ownGot && ownGot.id);
plate.retired = true;
const gone = LF.nodeOwningArticle(fake, "Holden Commodore (VR)", "t-lexcen");
check("not to a generation whose nameplate is gone", !gone || gone.id !== "t-vr", gone && gone.id);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
