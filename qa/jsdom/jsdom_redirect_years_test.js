// A car whose title redirects to a section of another car's article takes that section's
// years, not the whole page's (8 Nov 2026).
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
const page = "{{Infobox automobile\n| production = 1997–present\n}}\n==First generation (J100; 1997)==\n{{Infobox automobile\n| production = 1997–2006\n}}\n{{anchor|F500|Taruna}}The Taruna was sold in Indonesia.\n===Engines===\nText.\n==Second generation (J200; 2006)==\n{{Infobox automobile\n| production = 2006–2017\n}}\n";
const at = (f, label) => JSON.stringify(LF.sectionYearsForFragment(page, f, "Daihatsu", label));
check("an anchor inside a section takes that section's card", at("F500", "Taruna") === JSON.stringify({ year: 1997, end: 2006 }), at("F500", "Taruna"));
check("a heading fragment takes its own section's card", at("Second generation (J200; 2006)", "Terios") === JSON.stringify({ year: 2006, end: 2017 }), at("Second generation (J200; 2006)", "Terios"));
check("a fragment the page no longer has gives nothing", LF.sectionYearsForFragment(page, "Third generation (1979–1984)", "", "") === null);
check("the page's first card is the whole page's years", JSON.stringify(LF.pageCardYears(page)) === JSON.stringify({ year: 1997, end: null }));
const ry = window.REDIRECT_YEARS || {};
const shown = id => N(id) && [N(id).year, N(id).end].join("-");
check("the generated list is applied: Nissan 300C", !ry["llm-related-nissan-300c"] || shown("llm-related-nissan-300c") === ry["llm-related-nissan-300c"].join("-"), shown("llm-related-nissan-300c"));
check("the Maserati Quattroporte II is 1976-1978, not the whole nameplate's span", !ry["llm-related-maserati-quattroporte-ii"] || shown("llm-related-maserati-quattroporte-ii") === "1976-1978", shown("llm-related-maserati-quattroporte-ii"));
check("a car not on the list keeps its years: the Perodua Nautica", !N("llm-related-perodua-nautica") || shown("llm-related-perodua-nautica") === "2008-2009", shown("llm-related-perodua-nautica"));

const gallery = "{{Set index article|cars}}\n'''Honda Jazz''' may refer to:\n<gallery>\nA.jpg|Honda Jazz (1982–1986) {{main|Honda City (AA)}}\nB.jpg|Honda Jazz (2001) {{main|Honda Fit}}\n</gallery>\n";
check("a list of photos, each with a {{main}}, is a list page", LF.isListOfArticles(gallery) === true);
check("a page with a section delegating to a main article is not", LF.isListOfArticles("{{Set index article|cars}}\n==First==\n{{main|Honda City (AA)}}\nText.") === false);

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
