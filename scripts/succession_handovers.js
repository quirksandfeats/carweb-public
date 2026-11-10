#!/usr/bin/env node
// Writes app/succession_handovers.js: which generation of a successor nameplate
// took over from a predecessor, where the generations' own infoboxes say. The
// years alone pair a car still built after its successor began with the
// successor's next generation: the Renault 5's second generation, built to 1996,
// went to the Clio X65 (1998) and not the first Clio (1990), whose infobox gives
// "predecessor: Renault 5". A row is written when exactly one generation of the
// successor names the predecessor (its article, or one of its generations'
// articles) in its "predecessor" field, read from the generation's own article,
// or from its section of the nameplate's article (or the article that section's
// main-article note points to). It adds to the hand-kept list of five such cars.
// Nothing here is written by hand.
//
//   node scripts/succession_handovers.js CACHE.json      asks Wikipedia, keeping answers in CACHE.json
//
// Read every row against its article before committing a new table.
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
    if (f === "succession_handovers.js") { window.SUCCESSION_HANDOVERS = {}; continue; }
    if (f === "llm_families_data.js") continue;
    load(f);
  }
  window.CarWeb.boot();
  console.log = quiet;
  return { store, nodes: window.CARDATA.nodes, links: window.CARDATA.links, LF: window.LlmFamilies };
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
const article = t => String(t || "").split("#")[0].trim();
const idOf = v => typeof v === "string" ? v : v.id;
(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/succession_handovers.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
  const { nodes, links, LF } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const live = n => n && !n.retired;
  const gensOf = f => (f.generations || []).map(id => byId.get(id)).filter(g => live(g) && g.year != null).sort((a, b) => a.year - b.year);
  // Successions between two nameplates, at least the successor with generations.
  const pairs = new Map();
  links.forEach(l => {
    if (l.retired || l.type !== "succession") return;
    const s = byId.get(idOf(l.source)), t = byId.get(idOf(l.target));
    if (!live(s) || !live(t) || s.familyOf || t.familyOf || !s.wp || !t.wp || t.type !== "family" || gensOf(t).length < 2) return;
    pairs.set(s.id + "|" + t.id, { s, t });
  });
  async function texts(titles) {
    const need = [...new Set(titles.filter(Boolean))].filter(t => !(("text:" + t) in cache));
    for (let i = 0; i < need.length; i += 20) {
      const part = need.slice(i, i + 20);
      const r = await query({ action: "query", titles: part.join("|"), redirects: 1, prop: "revisions", rvprop: "content", rvslots: "main" });
      const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
      const reds = new Map((q.redirects || []).map(x => [x.from, x.to]));
      const pages = new Map((q.pages || []).map(p => [p.title, p]));
      part.forEach(t => { const n0 = norms.get(t) || t; const p = pages.get(reds.get(n0) || n0); cache["text:" + t] = p && p.revisions ? p.revisions[0].slots.main.content : ""; });
      save();
    }
    return t => cache["text:" + t] || "";
  }
  const T = [...pairs.values()];
  let text = await texts(T.flatMap(({ t }) => [article(t.wp), ...gensOf(t).map(g => article(g.wp))]));
  // Each successor generation's own text: its article, else its section of the
  // nameplate's article, through that section's main-article note when it has one.
  const mains = [];
  const genText = new Map();
  T.forEach(({ t }) => gensOf(t).forEach(g => {
    if (genText.has(g.id)) return;
    if (article(g.wp) && norm(article(g.wp)) !== norm(article(t.wp))) { genText.set(g.id, { title: article(g.wp) }); return; }
    const tc = LF.trailingCode ? LF.trailingCode(String(g.label)) : null;
    const code = tc && tc.code || String(g.label).slice(String(t.label).length).trim();
    const sec = code ? LF.sectionForCode(text(article(t.wp)), code) : null;
    if (!sec) return;
    const m = String(sec.body).slice(0, 600).match(/\{\{\s*(?:main|main article)\s*\|\s*([^|{}\n]+?)\s*(?:\||\}\})/i);
    if (m) { const mt = m[1].split("#")[0].trim(); mains.push(mt); genText.set(g.id, { title: mt }); }
    else genText.set(g.id, { body: sec.body });
  }));
  text = await texts(mains);
  // Where each predecessor link lands.
  const field = w => { const m = /\|\s*predecessor\s*=([\s\S]*?)(?=\n\s*\||\n\}\})/i.exec(String(w || "")); return m ? m[1] : ""; };
  const targetsOf = w => [...field(w).matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].trim());
  const allTargets = [...new Set([...genText.values()].flatMap(v => targetsOf(v.body != null ? v.body : text(v.title))))].filter(t => !(("look:" + t) in cache));
  for (let i = 0; i < allTargets.length; i += 50) {
    const part = allTargets.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1 });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x]));
    part.forEach(t => { const n0 = norms.get(t) || t, rd = reds.get(n0); cache["look:" + t] = { to: rd ? rd.to : n0 }; });
    save();
  }
  const landed = t => norm((cache["look:" + t] || { to: t }).to);
  const out = {}, report = [];
  T.forEach(({ s, t }) => {
    const sArticles = new Set([s, ...gensOf(s)].map(n => norm(article(n.wp))).filter(Boolean));
    const naming = gensOf(t).filter(g => { const v = genText.get(g.id); if (!v) return false;
      return targetsOf(v.body != null ? v.body : text(v.title)).some(x => sArticles.has(landed(x)) || sArticles.has(norm(x))); });
    if (naming.length !== 1) return;
    out[s.id + "|" + t.id] = naming[0].id;
    report.push(`${s.make} ${s.label} -> ${naming[0].label}`);
  });
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/succession_handovers.js"),
    "// Generated by scripts/succession_handovers.js. Do not edit: change the rule.\nwindow.SUCCESSION_HANDOVERS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  process.stdout.write(`${pairs.size} successions into a nameplate with generations, ${lines.length} handed over where an infobox says\n`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
