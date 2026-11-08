#!/usr/bin/env node
// Writes app/production_starts.js: generations whose stored read took the model-year
// range of their own infobox card where the card also gives a production range
// (productionRangesOnOwnCards in app/llm_families.js). The owner's basis is production
// years. A scan applies the same rule by itself; this covers reads made before it.
// Nothing here is written by hand.
//
//   node scripts/production_starts.js CACHE.json          fetches articles into CACHE.json
//
// Read a sample of the changes against their articles before committing a new table.
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
    if (f === "production_starts.js") { window.PRODUCTION_STARTS = {}; continue; }
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

async function query(params) {
  return post(new URLSearchParams(Object.assign({ format: "json", formatversion: 2 }, params)).toString());
}
(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/production_starts.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const { LF, nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const plates = nodes.filter(n => n.type === "family" && !n.retired && n.wp &&
    (n.generations || []).map(id => byId.get(id)).filter(g => g && !g.retired).length > 1);
  const need = [...new Set(plates.map(f => f.wp.split("#")[0]))].filter(t => !(t in cache));
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    const r = await query({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", redirects: 1, titles: batch.join("|") });
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    batch.forEach(t => { let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u; const p = pages.get(u); cache[t] = p && p.revisions ? p.revisions[0].slots.main.content : null; });
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const out = {};
  for (const f of plates) {
    const text = cache[f.wp.split("#")[0]];
    if (!text) continue;
    const gens = (f.generations || []).map(id => byId.get(id)).filter(g => g && !g.retired && g.year != null &&
      (!g.wp || g.wp.split("#")[0] === f.wp.split("#")[0]));
    const asRead = gens.map(g => ({ code: String(g.label).startsWith(f.label + " ") ? g.label.slice(f.label.length + 1) : g.label,
      yearStart: g.year, yearEnd: g.end == null ? null : g.end }));
    LF.productionRangesOnOwnCards(text, asRead).forEach((r, i) => {
      if (!r) return;
      const g = gens[i];
      out[g.id] = { from: g.year, start: r[0], fromEnd: g.end == null ? null : g.end, end: r[1] };
    });
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/production_starts.js"),
    "// Generated by scripts/production_starts.js. Do not edit: change the rule.\nwindow.PRODUCTION_STARTS = {\n" + lines.join("\n") + "\n};\n");
  console.log(`${plates.length} nameplates read, ${lines.length} generations take their card's production range`);
  process.exit(0);
})();
