#!/usr/bin/env node
// Writes app/own_articles.js: cars that now have an article of their own while
// their link still points at the page they used to be told on. Owner's report
// (10 Nov 2026): "Ford Contour" redirected to the first Mondeo's article when the
// car was found, so the Contour kept that link, and read its generations, designer
// and engines off the Mondeo; Wikipedia gave the Contour its own article on
// 2 Nov 2026. A row is written when the car's own name (make and label) is now a
// page of its own, not a redirect, not a list or disambiguation page, with a car
// infobox, and the car's present link either is where that name used to redirect
// (the store's redirect memory says so) or now redirects somewhere else itself.
// Nothing here is written by hand.
//
//   node scripts/own_articles.js CACHE.json      asks Wikipedia, keeping answers in CACHE.json
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
    if (f === "own_articles.js") { window.OWN_ARTICLES = {}; continue; }
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
const LISTS = ["Template:Set index article", "Template:Disambiguation", "Template:Car disambiguation", "Template:Hndis"];
const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const article = t => String(t || "").split("#")[0].trim();

(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/own_articles.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
  const { store, nodes } = bootApp();
  const redirects = store.wpRedirects || {};
  const cars = nodes.filter(n => !n.retired && (n.type === "model" || n.type === "family") && !n.familyOf && n.make && n.label && n.wp && !/^name-/.test(n.id));
  const ownTitle = n => `${n.make} ${n.label}`.replace(/\s+/g, " ").trim();
  const cands = cars.filter(n => norm(ownTitle(n)) !== norm(article(n.wp)));
  // Where each title lands now, and whether the page is a list.
  async function look(titles) {
    const need = [...new Set(titles)].filter(t => !(("look:" + t) in cache));
    for (let i = 0; i < need.length; i += 50) {
      const part = need.slice(i, i + 50);
      const r = await query({ action: "query", titles: part.join("|"), redirects: 1, prop: "templates|pageprops",
        tltemplates: LISTS.join("|"), tllimit: "max", ppprop: "disambiguation" });
      const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
      const reds = new Map((q.redirects || []).map(x => [x.from, x]));
      const pages = new Map((q.pages || []).map(p => [p.title, p]));
      part.forEach(t => {
        const n0 = norms.get(t) || t, rd = reds.get(n0), to = rd ? rd.to : n0, p = pages.get(to);
        cache["look:" + t] = { to, redirect: !!rd, missing: !p || !!p.missing,
          list: !!(p && ((p.templates || []).length || (p.pageprops && "disambiguation" in p.pageprops))) };
      });
      save();
    }
    return t => cache["look:" + t];
  }
  const L = await look(cands.flatMap(n => [ownTitle(n), article(n.wp)]));
  const real = cands.filter(n => { const o = L(ownTitle(n)); return o && !o.missing && !o.redirect && !o.list; });
  // The car's present link: where its own name used to redirect, or a page that
  // now redirects somewhere other than the car's own article.
  const stale = real.filter(n => {
    const was = article(n.wp), now = L(was), own = ownTitle(n);
    if (now && !now.missing && norm(article(now.to)) === norm(own)) return false;   // the same page, by another name
    const remembered = redirects[own] && norm(article(redirects[own])) === norm(was);
    return remembered || (now && now.redirect);
  });
  // A car infobox on the page.
  const needText = stale.map(ownTitle).filter(t => !(("text:" + t) in cache));
  for (let i = 0; i < needText.length; i += 20) {
    const part = needText.slice(i, i + 20);
    const r = await query({ action: "query", titles: part.join("|"), prop: "revisions", rvprop: "content", rvslots: "main" });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const p = pages.get(norms.get(t) || t); cache["text:" + t] = p && p.revisions ? p.revisions[0].slots.main.content : ""; });
    save();
  }
  const out = {}, report = [];
  stale.forEach(n => {
    const own = ownTitle(n), text = cache["text:" + own] || "";
    if (!/\{\{\s*infobox\s+(?:automobile|car|vehicle)/i.test(text)) { report.push(`not done ${n.id}: "${own}" has no car infobox`); return; }
    out[n.id] = { from: article(n.wp), to: own };
    report.push(`link     ${n.id}: "${article(n.wp)}" -> "${own}"`);
  });
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/own_articles.js"),
    "// Generated by scripts/own_articles.js. Do not edit: change the rule.\nwindow.OWN_ARTICLES = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  process.stdout.write(`${cands.length} cars named apart from their link, ${real.length} of whose names are articles now, ${lines.length} rows\n`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
