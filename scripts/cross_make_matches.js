#!/usr/bin/env node
// Writes app/cross_make_matches.js: relationships the model's background check
// approved as "the same car" under another maker's name, where the car's own
// article never gives it that name. Found 10 Nov 2026: the Nissan Leaf's and the
// Renault Kwid's "Venucia e30" (Dongfeng-Nissan's Chinese versions of them) were
// taken for the Zotye E30, a different car, and the Peugeot Partner for the Honda
// Partner. A badge of another maker is real (the Chevrolet Nexia is the Daewoo
// Nexia), so the article decides: a match stands when one of the names the
// mention gives ("Chevrolet Blazer/GMC Jimmy" gives two) is of the car's own make
// or appears in the car's own article; otherwise the mention and the car are
// listed here, and sanityMatchPlausible in app/llm_families.js refuses the match.
// Nothing here is written by hand.
//
//   node scripts/cross_make_matches.js CACHE.json      asks Wikipedia, keeping answers in CACHE.json
//
// Read every row against the two articles before committing a new table.
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
  window.LLM_FAMILIES = Object.assign({}, JSON.parse(JSON.stringify(store)), { __serverAvailable: false });
  for (const [, f] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    if (f === "cross_make_matches.js") { window.CROSS_MAKE_MATCHES = {}; continue; }
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
const article = t => String(t || "").split("#")[0].trim();

(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/cross_make_matches.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
  const { store, nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const makes = new Set(nodes.filter(n => n.type === "make" && !n.retired).map(n => norm(n.label)));
  const plateOf = n => (n && n.familyOf && byId.get(n.familyOf)) || n;
  // The make a name begins with: its longest leading run of up to three words that is a make.
  const makeOf = name => {
    const w = String(name).trim().split(/\s+/);
    for (let i = Math.min(3, w.length - 1); i >= 1; i--) if (makes.has(norm(w.slice(0, i).join(" ")))) return norm(w.slice(0, i).join(" "));
    return null;
  };
  const rows = [];
  Object.keys(store.relations || {}).forEach(key => {
    const e = store.relations[key];
    if (!e || e.status !== "confirmed" || e.decidedBy) return;
    const m = /same car as "([^"]+)"/.exec(e.reason || "");
    if (!m) return;
    const mention = m[1];
    // The car the mention was matched to: the side whose nameplate's name it carries.
    const sides = [e.genIdA, e.genIdB].map(id => byId.get(id)).filter(Boolean)
      .filter(c => { const p = plateOf(c); return norm(p.label) && norm(mention).includes(norm(p.label)); });
    if (sides.length !== 1) return;
    const car = sides[0], own = norm(car.make);
    const names = mention.replace(/\([^()]*\)/g, " ").split("/").map(s => s.trim()).filter(Boolean);
    const named = names.map(makeOf);
    // One make by two names ("Maruti", "Maruti Suzuki") is one make.
    const same = mk => mk === own || own.startsWith(mk) || mk.startsWith(own);
    if (!named.some(Boolean) || named.some(mk => !mk || same(mk))) return;   // a name of its own make, or of none
    const page = article(car.wp || (plateOf(car) || {}).wp);
    if (!page) return;
    const by = [e.genIdA, e.genIdB].map(id => byId.get(id)).find(c => c && c !== car) || null;
    rows.push({ key, mention, names, car, by, page });
  });
  const need = [...new Set(rows.map(r => r.page))].filter(t => !(("text:" + t) in cache));
  for (let i = 0; i < need.length; i += 20) {
    const part = need.slice(i, i + 20);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1, prop: "revisions", rvprop: "content", rvslots: "main" });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const n0 = norms.get(t) || t; const p = pages.get(reds.get(n0) || n0); cache["text:" + t] = p && p.revisions ? p.revisions[0].slots.main.content : ""; });
    save();
  }
  // Where each name the mention gives lands on Wikipedia. A name that is the
  // article of another car in the graph ("Cadillac De Ville", the Cadillac de
  // Ville series) is that car's, and turning the match down would only make a
  // second node of it beside the first; such a match is left for a person. The
  // mentioning car's own other name (the Starion's "Dodge Conquest") is no other car.
  const names = [...new Set(rows.flatMap(r => r.names))].filter(t => !(("look:" + t) in cache));
  for (let i = 0; i < names.length; i += 50) {
    const part = names.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1 });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => {
      const n0 = norms.get(t) || t, rd = reds.get(n0), to = rd ? rd.to : n0, p = pages.get(to);
      cache["look:" + t] = { to, fragment: rd && rd.tofragment || null, missing: !p || !!p.missing };
    });
    save();
  }
  const carsByArticle = new Map();
  nodes.forEach(n => {
    if (n.retired || (n.type !== "model" && n.type !== "family") || !n.wp) return;
    const k = norm(article(n.wp));
    (carsByArticle.get(k) || carsByArticle.set(k, []).get(k)).push(n);
  });
  const elsewhere = r => r.names.map(t => cache["look:" + t]).find(at => at && !at.missing && !at.fragment &&
    (carsByArticle.get(norm(at.to)) || []).some(n => n.id !== r.car.id && plateOf(n) !== plateOf(r.car) &&
      !(r.by && (n.id === r.by.id || plateOf(n) === plateOf(r.by)))));
  const out = {}, report = [];
  rows.forEach(r => {
    const text = cache["text:" + r.page] || "";
    if (!text) { report.push(`unread   ${r.key}: "${r.page}"`); return; }
    // The name as written, or its make with the model's first word close after
    // ("Maruti Suzuki Esteem" for "Maruti Esteem", "Datsun Bluebird" for "Datsun Bluebird 211").
    const flat = norm(text);
    const words = String(text).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const near = n => {
      const w = n.normalize("NFKD").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const mk = makeOf(n), mkLen = mk ? n.trim().split(/\s+/).findIndex((x, i, all) => norm(all.slice(0, i + 1).join(" ")) === mk) + 1 : 1;
      const head = w[0], model = w[mkLen];
      if (!head || !model) return false;
      for (let i = 0; i < words.length; i++) if (words[i] === head && words.slice(i + 1, i + 4).includes(model)) return true;
      return false;
    };
    if (r.names.some(n => flat.includes(norm(n)) || near(n))) { report.push(`kept     ${r.key}: "${r.mention}" is in "${r.page}"`); return; }
    const other = elsewhere(r);
    if (other) { report.push(`left     ${r.key}: "${r.mention}" is the article "${other.to}" of another car`); return; }
    out[norm(r.mention) + "|" + r.car.id] = { mention: r.mention, page: r.page };
    report.push(`apart    ${r.key}: "${r.mention}" is not in "${r.page}"`);
  });
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/cross_make_matches.js"),
    "// Generated by scripts/cross_make_matches.js. Do not edit: change the rule.\nwindow.CROSS_MAKE_MATCHES = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  process.stdout.write(`${rows.length} matches under another make's name, ${lines.length} not named in the car's article\n`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
