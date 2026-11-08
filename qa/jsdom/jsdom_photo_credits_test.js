// A card credits its photo with the author and licence from the file page (8 Nov 2026).
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
const asked = [];
window.fetch = async url => {
  url = String(url);
  if (/w\/api\.php/.test(url) && /prop=imageinfo/.test(url)) {
    asked.push(decodeURIComponent(url.split("titles=")[1] || ""));
    return { ok: true, json: async () => ({ query: { pages: [{ title: "File:x", imageinfo: [{ extmetadata: {
      Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a><img src=x onerror="window.__pwned=1">' },
      LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" } } }] }] } }) };
  }
  if (/rest_v1\/page\/summary/.test(url)) return { ok: true, json: async () => ({ type: "standard", extract: "A car.",
    thumbnail: { source: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Test_Car_front.jpg/320px-Test_Car_front.jpg" },
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Test" } } }) };
  return { ok: true, json: async () => ({}), text: async () => "{}" };
};
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
const settle = () => new Promise(r => setTimeout(r, 50));
(async () => {
  const SK = window.PHOTO_SKIPS || {};
  const gen = DATA.nodes.find(n => n.wikiFile && !Object.prototype.hasOwnProperty.call(SK, n.wikiFile) && !n.dbphoto && !n.db);
  window.CarWeb.openDetail(gen);
  await settle();
  const el = window.document.querySelector(".dt-imgcredit");
  check("a generation's photo is credited with its author and licence", el && !el.hidden && el.textContent === "Photo: Jane Doe, CC BY-SA 4.0", el && el.textContent);
  check("the file asked about is the generation's own", asked.includes("File:" + String(gen.wikiFile).replace(/_/g, " ")), asked.join(" | "));
  check("the author's page markup is shown as text only", el.querySelectorAll("img").length === 0 && window.__pwned === undefined);
  const links = [...el.querySelectorAll("a")].map(a => a.href);
  check("the author links to the file page and the licence to its deed", /\/wiki\/File%3A/.test(links[0] || "") && /creativecommons\.org/.test(links[1] || ""), links.join(" "));
  const thumbCar = DATA.nodes.find(n => n.type === "model" && !n.familyOf && n.wp && !n.wikiFile && !n.dbphoto && !n.db);
  window.CarWeb.openDetail(thumbCar);
  await settle();
  check("the article's thumbnail is credited too", !el.hidden && asked.includes("File:Test Car front.jpg"), asked.slice(-1)[0]);
  const plain = DATA.nodes.find(n => !n.wp && !n.wikiFile && !n.dbphoto && !n.db && n.type === "model");
  window.CarWeb.openDetail(plain);
  await settle();
  check("a card with no photo shows no credit", el.hidden && el.textContent === "");
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
  process.exit(fails ? 1 : 0);
})();
