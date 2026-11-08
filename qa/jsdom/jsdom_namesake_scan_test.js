// A person minted by a scan is checked against the makes of the car the scan credited
// them on: the credit link is pushed after the person is made (8 Nov 2026).
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const check = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const GENERAL = "{{Infobox military person\n|name=Zebulon Quartermaine\n|birth_date=1730\n|death_date=1800}}\n'''Zebulon Quartermaine''' (1730-1800) was a Russian general.";
const DESIGNER = "{{Infobox person\n|name=Quinta Farrowdale\n|birth_date=1961}}\n'''Quinta Farrowdale''' (born 1961) is a car designer who led exterior design at [[Hyundai]].";
const fetchStub = (url, opts) => {
  url = decodeURIComponent(String(url));
  if (url.includes("wikipedia.org")) {
    const page = /Quinta/.test(url) ? DESIGNER : /Zebulon/.test(url) ? GENERAL : "";
    const title = /Quinta/.test(url) ? "Quinta Farrowdale" : "Zebulon Quartermaine";
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ parse: { title, wikitext: { "*": page } } }) });
  }
  if (url.includes("/api/llm/chat")) {
    const body = JSON.parse(opts.body);
    const said = JSON.stringify(body);
    const facts = /Quinta/.test(said) ? { born: 1961, died: null, country: "South Korea" } : { born: 1730, died: 1800, country: "Russia" };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(facts) }, finish_reason: "stop" }] }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
};
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
const noop = () => {};
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({ measureText: () => ({ width: 10 }) }, { get: (t, k) => k in t ? t[k] : noop, set: () => true });
window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = noop;
window.matchMedia = q => ({ matches: false, media: q, addEventListener: noop, removeEventListener: noop });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
window.Element.prototype.scrollIntoView = noop;
window.fetch = fetchStub;
window.XMLHttpRequest = function () { this.open = noop; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const quiet = console.log; console.log = console.warn = console.info = console.error = noop;
window.LLM_FAMILIES = Object.assign(JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8")), { __serverAvailable: true });
for (const [, f] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  if (f === "llm_families_data.js") continue;
  window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
}
window.CarWeb.boot();
console.log = quiet;
const LF = window.LlmFamilies, nodes = window.CARDATA.nodes, links = window.CARDATA.links;
LF.setBackgroundAllowed(true);
nodes.push({ id: "m-test-car", type: "model", label: "Testra", make: "Hyundai", year: 2015, wp: "Hyundai Testra" });
window.LLM_FAMILIES.families["m-test-car"] = { status: "confirmed", decidedBy: "agent", checkedAt: "x", sourceTitle: "Hyundai Testra",
  proposal: { hasMultipleGenerations: true, generations: [
    { code: "GS", yearStart: 2014, yearEnd: 2020, designers: ["Zebulon Quartermaine", "Quinta Farrowdale"], engineers: [], sharedPlatforms: [] },
    { code: "SU2", yearStart: 2020, yearEnd: null, designers: [], engineers: [], sharedPlatforms: [] } ] } };
LF.applyConfirmed(nodes, links);
const z = nodes.find(n => n.type === "person" && n.label === "Zebulon Quartermaine");
const q = nodes.find(n => n.type === "person" && n.label === "Quinta Farrowdale");
setTimeout(() => {
  check("both designers were made", !!z && !!q);
  check("a namesake's page that names no credited make gives no dates", z && z.born !== 1730 && z.died !== 1800, z && `${z.born}-${z.died} ${z.factsSource}`);
  check("a page that names the credited make is used", q && q.born === 1961, q && `${q.born} ${q.factsSource}`);
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
  process.exit(fails ? 1 : 0);
}, 3000);
