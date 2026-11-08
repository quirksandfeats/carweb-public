// Generation years on the production basis: a read that took a card's model years gets its production range (8 Nov 2026).
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
const g = id => DATA.nodes.find(n => n.id === id);
const cav = g("llm-m-chevrolet-cavalier-first-generation-1982-1987");
check("the Cavalier's first generation begins when it was built, 1981, not model year 1982", cav && cav.year === 1981, cav && cav.year);
const rng = g("llm-m-ford-ranger-americas-second-generation-1993-1997");
check("the 1993 Ranger begins in 1992", rng && rng.year === 1992 && rng.end === 1997, rng && `${rng.year}-${rng.end}`);
const ART = "{{Infobox automobile\n| name = Testcar\n}}\n== First generation (1982) ==\n{{Infobox automobile\n| production = August 1981 – 1987\n| model_years = 1982–1988\n}}\nText.\n" +
  "== Second generation (1988) ==\n{{Infobox automobile\n| production = 1988–1994\n}}\nText.\n== Third generation (1995) ==\n{{Infobox automobile\n| production = 1991–1999\n| model_years = 1995–2005\n}}\n";
const gens = [{ code: "First generation", yearStart: 1982, yearEnd: 1988 }, { code: "Second generation", yearStart: 1988, yearEnd: 1994 }, { code: "Third generation", yearStart: 1995, yearEnd: 2005 }];
const got = LF.productionRangesOnOwnCards(ART, gens);
check("a read that took the card's model years gets its production range", JSON.stringify(got[0]) === "[1981,1987]", JSON.stringify(got[0]));
check("a card with production years only is left alone", got[1] === null, JSON.stringify(got[1]));
check("a production start more than two years before the model years is not taken", got[2] === null, JSON.stringify(got[2]));
check("a read that already took production years is left alone",
  LF.productionRangesOnOwnCards(ART, [{ code: "First generation", yearStart: 1981, yearEnd: 1987 }, gens[1]])[0] === null);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
