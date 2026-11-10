// Electric motors as nodes, like engines (10 Nov 2026).
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
const nodes = window.CARDATA.nodes, links = window.CARDATA.links;
const byId = new Map(nodes.map(n => [n.id, n]));
const idOf = v => typeof v === "string" ? v : v.id;
const fittedTo = id => links.filter(l => !l.retired && l.type === "fitted" && idOf(l.source) === id).map(l => idOf(l.target));
const m1nm = byId.get("mot-1nm");
check("Toyota's 1NM motor is a node", !!m1nm && m1nm.type === "engine" && m1nm.motor && m1nm.label === "Toyota 1NM", m1nm && m1nm.label);
check("fitted to the cars that share it, the Toyota-built Mazda2 Hybrid among them", fittedTo("mot-1nm").length >= 5 &&
  fittedTo("mot-1nm").some(id => (byId.get(id) || {}).make === "Mazda"), fittedTo("mot-1nm").length);
check("Nissan's EM57 joins the Leaf and the e-NV200's NV200", fittedTo("mot-em57").includes("m-nissan-leaf-first-generation"));
check("a motor type is no node", !nodes.some(n => n.motor && /synchronous/i.test(n.label)));
check("a version named in brackets is no motor: the Lexus UX's KMA10", !byId.get("mot-kma10"));
check("a car's name is no motor: the Volvo XC40", !byId.get("mot-xc40"));
const LF = window.LlmFamilies;
window.CarWeb.openDetail && window.CarWeb.openDetail(m1nm);
const kicker = (document.querySelector(".dt-kicker") || {}).textContent || "";
check("its card says it is an electric motor", /electric motor/i.test(kicker) || !window.CarWeb.openDetail, kicker);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
