// Reads of a page that only lists other articles are not replayed as generations,
// and a name with no page of its own there that only its own maker uses gives way to the
// cars that carry it as an also-called name (8 Nov 2026).
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
const idOf = v => (typeof v === "string" ? v : v.id);
const N = id => DATA.nodes.find(n => n.id === id);
const named = (id, type = "platform") => DATA.links.filter(l => !l.retired && !l.mirror && l.type === type && (idOf(l.source) === id || idOf(l.target) === id))
  .map(l => idOf(l.source) === id ? idOf(l.target) : idOf(l.source));
const LF = window.LlmFamilies;
const L = window.LIST_PAGE_READS || {};
const live = id => !!N(id) && !N(id).retired;
check("the list of list-page reads is loaded", Object.keys(L).length >= 20, Object.keys(L).length);
check("Honda Jazz is not a nameplate of other cars", !N("llm-related-honda-jazz") || N("llm-related-honda-jazz").type !== "family");
check("a name only its own maker uses steps aside: Chevrolet Prisma", !live("llm-related-chevrolet-prisma") && (N("llm-related-chevrolet-prisma").badgeOf || []).length > 0, N("llm-related-chevrolet-prisma") && N("llm-related-chevrolet-prisma").retiredReason);
check("another maker's badge stays a car: Opel Vivaro beside the Renault Trafic", live("m-opel-vivaro") && named("m-opel-vivaro").some(id => /renault-trafic/.test(id)), named("m-opel-vivaro").join());
check("a name that is both stays a car: Honda Jazz (also the Isuzu MU)", live("llm-related-honda-jazz"));
check("the Isuzu MU is no Jazz generation", !DATA.nodes.some(n => !n.retired && n.familyOf === "llm-related-honda-jazz"));
const fit = DATA.nodes.find(n => !n.retired && n.make === "Honda" && n.label === "Fit");
check("the Fit carries Honda Jazz as an also-called name", !!fit && LF.aliasesFor(fit.id).some(a => /Jazz/.test(a)), fit && LF.aliasesFor(fit.id).join(" | "));
check("a name with pages of its own stays to be re-read: Ford Maverick", live("llm-related-ford-maverick"));
check("the Fiat Ducato, named on the Talento's page, stays", live("llm-related-fiat-ducato") && DATA.nodes.some(n => !n.retired && n.familyOf === "llm-related-fiat-ducato"));
check("the Alfa Romeo Giulietta (2010) is a car of its own again", live("m-alfa-romeo-giulietta-2010") || DATA.nodes.some(n => !n.retired && !n.familyOf && n.make === "Alfa Romeo" && n.label === "Giulietta (2010)"));
const s = window.LLM_FAMILIES;
check("a read after the list rule of a page it caught still replays: Jaguar XF", !L["fam-jaguar-xf"]);

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
