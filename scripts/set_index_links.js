#!/usr/bin/env node
// Writes app/set_index_links.js: cars whose article link is a list of the cars
// that share a name (a set index or disambiguation page) instead of their own
// article. Owner's report (9 Nov 2026): the 2013 BMW i3 pointed at "BMW i3",
// which became such a list when the 2026 i3 arrived, so no reading of its
// article found anything. Each row names the one entry on the list that is this
// car: its title starts with the car's make and carries its name (or is the
// name with "(automobile)", as "Devrim (automobile)"), no other car
// in the graph has it, and the years on its line begin with the car's (or, with
// no years, its bracket says it is the car: "Ford Prefect (car)"). A nameplate
// with generations is left alone: a list of them is its article. Nothing here
// is written by hand.
//
//   node scripts/set_index_links.js CACHE.json      asks Wikipedia, keeping answers in CACHE.json
//
// Read every row against its list page before committing a new table.
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
    if (f === "set_index_links.js") { window.SET_INDEX_LINKS = {}; continue; }
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
const norm = s => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const LISTS = ["Template:Set index article", "Template:Disambiguation", "Template:Car disambiguation", "Template:Hndis"];
(async () => {
  const cachePath = process.argv[2];
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
  const { nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const live = n => n && !n.retired;
  const cars = nodes.filter(n => live(n) && (n.type === "model" || n.type === "family") && n.wp && !/^name-/.test(n.id));
  const article = t => String(t || "").split("#")[0];
  // Which titles are lists: the templates each page carries.
  const titles = [...new Set(cars.map(n => article(n.wp)))].filter(t => !(("list:" + t) in cache));
  for (let i = 0; i < titles.length; i += 50) {
    const part = titles.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), prop: "templates|pageprops", tltemplates: LISTS.join("|"), tllimit: "max", ppprop: "disambiguation" });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => {
      const p = pages.get(norms.get(t) || t);
      cache["list:" + t] = !!(p && ((p.templates || []).length || (p.pageprops && "disambiguation" in p.pageprops)));
    });
    if (i % 1000 === 0) save();
  }
  // The single cars on a list, and the list's own text.
  const onList = cars.filter(n => cache["list:" + article(n.wp)] && !n.familyOf &&
    !(n.generations || []).some(id => live(byId.get(id))));
  const need = [...new Set(onList.map(n => article(n.wp)))].filter(t => !(("text:" + t) in cache));
  for (let i = 0; i < need.length; i += 20) {
    const part = need.slice(i, i + 20);
    const r = await query({ action: "query", titles: part.join("|"), prop: "revisions", rvprop: "content", rvslots: "main" });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => {
      const p = pages.get(norms.get(t) || t);
      cache["text:" + t] = p && p.revisions ? p.revisions[0].slots.main.content : "";
    });
  }
  save();
  const taken = new Map();
  // Titles stored percent-encoded ("Fiat 500 %22Topolino%22") are the same page.
  const plain = t => { try { return decodeURIComponent(t); } catch (e) { return t; } };
  cars.forEach(n => { const t = norm(plain(article(n.wp))); taken.set(t, (taken.get(t) || []).concat(n.id)); });
  const out = {}, report = [];
  for (const n of onList) {
    const from = article(n.wp), text = cache["text:" + from] || "";
    const make = norm(n.make), label = norm(n.label);
    const cands = [];
    for (const line of text.split("\n").filter(l => /^\s*\*/.test(l))) {
      const m = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/.exec(line);
      if (!m) continue;
      const to = m[1].trim(), key = norm(to);
      // Its title starts with the make and carries the car's name, or it is the
      // name told apart as a car ("Devrim (automobile)" on the "Devrim" list).
      const asCar = new RegExp("^(?:" + String(n.make || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " )?" +
        String(n.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\((?:car|automobile|vehicle)\\)$", "i").test(to);
      if ((!asCar && (!key.startsWith(make) || !key.includes(label))) || key === norm(from)) continue;
      if ((taken.get(key) || []).some(id => id !== n.id)) continue;
      const years = (line.match(/\b(?:18[89]\d|19\d\d|20\d\d)\b/g) || []).map(Number);
      const isCar = /\((?:car|automobile|vehicle)\)$/i.test(to);
      if (years.length ? (n.year != null && Math.abs(years[0] - n.year) <= 1) : isCar) cands.push({ to, years });
    }
    // An article of its own: an entry that redirects into another car's article
    // (the Suzuki Across into the RAV4's) is that car's section, not a page for this one.
    const own = [];
    for (const c of cands) {
      if (!(("resolve:" + c.to) in cache)) {
        const r = await query({ action: "query", titles: c.to, redirects: 1 });
        const q = r.query || {}, pg = (q.pages || [])[0];
        cache["resolve:" + c.to] = { redirect: !!(q.redirects || []).length, missing: !pg || !!pg.missing };
        save();
      }
      const rv = cache["resolve:" + c.to];
      if (rv.redirect || rv.missing) { report.push(`not done ${n.make} ${n.label} ${n.year || ""}: "${c.to}" is a redirect into another article`); continue; }
      own.push(c);
    }
    if (own.length === 1) {
      out[n.id] = { from, to: own[0].to };
      report.push(`link     ${n.make} ${n.label} ${n.year || ""}: "${from}" -> "${own[0].to}"`);
    } else if (own.length || !cands.length) report.push(`not done ${n.make} ${n.label} ${n.year || ""}: "${from}" (${own.length || cands.length} entries fit)`);
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/set_index_links.js"),
    "// Generated by scripts/set_index_links.js. Do not edit: change the rule.\nwindow.SET_INDEX_LINKS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  process.stdout.write(`${lines.length} rows\n`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
