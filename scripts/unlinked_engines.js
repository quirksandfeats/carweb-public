#!/usr/bin/env node
// Writes app/unlinked_engines.js: engines a car's infobox names by code in plain
// text, which Wikipedia does have a title for. The second Honda NSX's "JNC1" lost
// its link on 8 Nov 2026, when "Honda JNC1 engine" became a redirect to the NSX's
// own section; the reader keeps such a line as text, so the NSX showed no engine.
// A row is written for a car's plain-text engine line that carries a code when
// "<make> <code> engine" is a page or a redirect, and it does not land on a list
// of engines. The engine is then drawn like any other.
// Nothing here is written by hand.
//
//   node scripts/unlinked_engines.js CACHE.json      asks Wikipedia, keeping answers in CACHE.json
//
// Read every row against its page before committing a new table.
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
  const store = JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8"));
  window.LLM_FAMILIES = Object.assign({}, store, { __serverAvailable: false });
  for (const [, f] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    if (f === "unlinked_engines.js") { window.UNLINKED_ENGINES = {}; continue; }
    if (f === "llm_families_data.js") continue;
    load(f);
  }
  window.CarWeb.boot();
  console.log = quiet;
  return { store, nodes: window.CARDATA.nodes };
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
// A read that times out or is turned away is asked again, after a pause.
async function query(params) {
  const body = new URLSearchParams(Object.assign({ format: "json", formatversion: 2 }, params)).toString();
  for (let attempt = 0; ; attempt++) {
    try { return await post(body); }
    catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}
const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/unlinked_engines.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
  const { store, nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const want = [];
  Object.keys(store.engineScans || {}).forEach(id => {
    const rec = store.engineScans[id], car = byId.get(id);
    if (!rec || !car || car.retired || !car.make || (rec.v === 0 && rec.staleReason)) return;
    (rec.unlinked || []).forEach(u => {
      const name = String(u && u.name || "");
      if (!name.includes(" · ")) return;   // a line with no code is named by its specs
      const code = name.split(" · ")[0].trim();
      if (!/\d/.test(code) || !/[A-Za-z]/.test(code)) return;
      want.push({ id, code, said: u.said || "", title: `${car.make} ${code} engine` });
    });
  });
  const titles = [...new Set(want.map(w => w.title))].filter(t => !(("look:" + t) in cache));
  for (let i = 0; i < titles.length; i += 50) {
    const part = titles.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1 });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const n0 = norms.get(t) || t, rd = reds.get(n0), to = rd ? rd.to : n0, p = pages.get(to);
      cache["look:" + t] = { to, fragment: rd && rd.tofragment || null, missing: !p || !!p.missing }; });
    save();
  }
  const out = {}, report = [];
  want.forEach(w => {
    const at = cache["look:" + w.title];
    if (!at || at.missing) return;
    if (/^List of\b/i.test(at.to)) { report.push(`list     ${w.id}: "${w.title}" -> "${at.to}"`); return; }
    if ((out[w.id] || []).some(x => x.title === w.title)) return;
    (out[w.id] = out[w.id] || []).push({ title: w.title, name: w.code, said: w.said });
    report.push(`engine   ${w.id}: ${w.code} -> "${w.title}" (${at.to}${at.fragment ? "#" + at.fragment : ""})`);
  });
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/unlinked_engines.js"),
    "// Generated by scripts/unlinked_engines.js. Do not edit: change the rule.\nwindow.UNLINKED_ENGINES = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  process.stdout.write(`${want.length} coded plain-text engine lines, ${lines.length} cars given an engine\n`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
