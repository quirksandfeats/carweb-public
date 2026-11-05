#!/usr/bin/env node
// Writes app/namesake_people.js: people whose born, died and country came from a
// page found by their name alone, when that page names none of the makes of the
// cars credited to them (personPageIsTheirs in app/llm_families.js). A scan applies
// the same rule by itself; this covers people looked up before it arrived.
// Nothing here is written by hand.
//
//   node scripts/namesake_people.js CACHE.json          fetches pages into CACHE.json
//
// Read the list against the pages before committing a new table.
const fs = require("fs"), path = require("path"), https = require("https");
const ROOT = path.join(__dirname, "..");
const { JSDOM } = require(path.join(ROOT, "qa/jsdom/node_modules/jsdom"));

function bootApp() {
  const APP = path.join(ROOT, "app"), noop = () => {};
  const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({ measureText: () => ({ width: 10 }) }, { get: (t, k) => k in t ? t[k] : noop, set: () => true });
  window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = noop;
  window.matchMedia = q => ({ matches: false, media: q, addEventListener: noop, removeEventListener: noop });
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  window.Element.prototype.scrollIntoView = noop;
  window.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
  window.XMLHttpRequest = function () { this.open = noop; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  const quiet = console.log; console.log = console.warn = console.info = console.error = noop;
  window.LLM_FAMILIES = Object.assign(JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8")), { __serverAvailable: false });
  for (const [, f] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    if (f === "namesake_people.js") { window.NAMESAKE_PEOPLE = {}; continue; }
    if (f === "llm_families_data.js") continue;
    load(f);
  }
  window.CarWeb.boot();
  console.log = quiet;
  return { LF: window.LlmFamilies, nodes: window.CARDATA.nodes, links: window.CARDATA.links };
}

function post(body) {
  return new Promise((res, rej) => {
    const req = https.request("https://en.wikipedia.org/w/api.php", { method: "POST", headers: {
      "User-Agent": "CarWebEngineSweep/1.0 (https://github.com/quirksandfeats/carweb-public)", "Content-Type": "application/x-www-form-urlencoded" } }, r => {
      let d = ""; r.setEncoding("utf8"); r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on("error", rej); req.end(body);
  });
}
async function fetchArticles(titles, cachePath) {
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const need = titles.filter(t => !(t in cache));
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const r = await post(new URLSearchParams({ action: "query", format: "json", formatversion: 2, prop: "revisions", rvprop: "content", rvslots: "main", redirects: 1, titles: batch.join("|") }).toString());
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    batch.forEach(t => {
      let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u;
      const p = pages.get(u);
      if (p && p.revisions) cache[t] = p.revisions[0].slots.main.content;
    });
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache;
}

async function redirectsOf(titles, cachePath) {
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const r = await post(new URLSearchParams({ action: "query", format: "json", formatversion: 2, redirects: 1, titles: titles.slice(i, i + 50).join("|") }).toString());
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    titles.slice(i, i + 50).forEach(t => { let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u; if (u !== t) out[t] = u; });
    await new Promise(z => setTimeout(z, 300));
  }
  fs.writeFileSync(cachePath, JSON.stringify(out));
  return out;
}


(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/namesake_people.js CACHE.json"); process.exit(1); }
  const { LF, nodes, links } = bootApp();
  const idOf = v => typeof v === "string" ? v : v.id;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const makes = new Map();
  links.forEach(l => {
    if (l.retired || (l.type !== "designed" && l.type !== "engineered")) return;
    const a = byId.get(idOf(l.source)), b = byId.get(idOf(l.target));
    if (!a || !b) return;
    const [p, car] = a.type === "person" ? [a, b] : [b, a];
    if (p.type !== "person" || !car.make || car.retired) return;
    if (!makes.has(p.id)) makes.set(p.id, new Set());
    makes.get(p.id).add(car.make);
  });
  const people = nodes.filter(n => n.type === "person" && !n.retired && !n.wp && n.factsSource === "wikipedia");
  const pages = await fetchArticles([...new Set(people.map(p => p.label))], cachePath);
  const titles = await redirectsOf([...new Set(people.map(p => p.label))], cachePath + ".redirects");
  const out = {};
  for (const p of people) {
    const text = pages[p.label];
    if (!text) continue;  // no page: the facts came from somewhere this cannot check
    if (!LF.personPageIsTheirs(text, [...(makes.get(p.id) || [])])) out[p.id] = titles[p.label] || p.label;
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/namesake_people.js"),
    "// Generated by scripts/namesake_people.js. Do not edit: change the rule.\nwindow.NAMESAKE_PEOPLE = {\n" + lines.join("\n") + "\n};\n");
  console.log(`${people.length} people looked up by name, ${lines.length} from a page about someone else`);
  process.exit(0);
})();
