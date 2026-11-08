#!/usr/bin/env node
// Writes app/redirect_years.js: years for cars whose own title redirects to a
// section of another car's article, read from that section by
// sectionYearsForFragment in app/llm_families.js. Before that rule a scan took the
// whole article's span: the Daihatsu Taruna showed the Terios's 1997-. A scan now
// applies the rule by itself; this covers cars read before it. Nothing here is
// written by hand.
//
//   node scripts/redirect_years.js CACHE.json          fetches pages into CACHE.json
//
// Read the changes against their articles before committing a new table.
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
    if (f === "redirect_years.js") { window.REDIRECT_YEARS = {}; continue; }
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
  if (!cachePath) { console.error("usage: node scripts/redirect_years.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : { redirects: {}, pages: {} };
  const { LF, nodes } = bootApp();
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, "app/llm_families.json"), "utf-8"));
  const facts = store.mintedFacts || {};
  const cars = nodes.filter(n => n.type === "model" && !n.retired && /^llm-related-/.test(n.id) &&
    facts[n.id] && facts[n.id].source === "wikipedia" && (facts[n.id].year != null || facts[n.id].end != null));
  const asked = cars.map(n => `${n.make || ""} ${n.label}`.trim());
  const need = [...new Set(asked)].filter(t => !(t in cache.redirects));
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const r = await query({ action: "query", redirects: 1, titles: batch.join("|") });
    const q = r.query || {}, norm = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const red = new Map((q.redirects || []).map(x => [x.from, x]));
    batch.forEach(t => { const x = red.get(norm.get(t) || t); cache.redirects[t] = x ? { to: x.to, fragment: x.tofragment || null } : null; });
    await new Promise(z => setTimeout(z, 300));
  }
  const targets = [...new Set(Object.values(cache.redirects).filter(x => x && x.fragment).map(x => x.to))].filter(t => !(t in cache.pages));
  for (let i = 0; i < targets.length; i += 40) {
    const batch = targets.slice(i, i + 40);
    const r = await query({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: batch.join("|") });
    for (const p of (r.query && r.query.pages) || []) if (p.revisions) cache.pages[p.title] = p.revisions[0].slots.main.content;
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const out = {};
  cars.forEach((n, i) => {
    const x = cache.redirects[asked[i]];
    if (!x || !x.fragment || !cache.pages[x.to]) return;
    // Only years the whole page gave: a stored start that is the page card's own start.
    // A car already holding years of its own section keeps them (the Perodua Nautica).
    const page = cache.pages[x.to], whole = LF.pageCardYears(page);
    if (!whole || facts[n.id].year !== whole.year) return;
    // A section that gives no years (or a heading renamed since) proves nothing: the car keeps what it has.
    const own = LF.sectionYearsForFragment(page, x.fragment, n.make || "", n.label);
    if (own) out[n.id] = [own.year, own.end];
  });
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/redirect_years.js"),
    "// Generated by scripts/redirect_years.js. Do not edit: change the rule.\nwindow.REDIRECT_YEARS = {\n" + lines.join("\n") + "\n};\n");
  console.log(`${cars.length} cars with looked-up years, ${lines.length} redirect to a section that gives years`);
  process.exit(0);
})();
