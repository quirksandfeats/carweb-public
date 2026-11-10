#!/usr/bin/env node
// Writes app/duplicate_cars.js: single cars that are a generation of a nameplate
// shown twice. The owner's ruling (10 Nov 2026): where one node holds the
// information and the other holds none of its own, the empty one goes into the
// full one. A row is written for a car standing on its own (no generations) when
// all of these hold:
//   - its link is the article of a nameplate with generations (it has no
//     article of its own);
//   - one of that nameplate's generations is it: the codes in their names meet
//     ("SEAT León Mk1" and "León Mk1 (1M)"), or, where the car's name carries no
//     code, their years are the same production run ("Toyota Veloz" 2021 and
//     "Avanza W100" 2021). A code that differs rules a pair out ("Audi S3 Mk1" is
//     no "A3 8V"), and a run of under three years never matches by years alone:
//     show cars share their years (the 1964 Pontiac Banshees XP-798 and XP-833,
//     the 1940 Chrysler Thunderbolt and Newport);
//   - every connection it has, the generation or its nameplate has too;
//   - the nameplate's article gives its name (a name of the car, not a word of it).
// The car's name stays as another name of the generation. Nothing here is
// written by hand.
//
//   node scripts/duplicate_cars.js CACHE.json      asks Wikipedia, keeping answers in CACHE.json
//
// Read every row against the article before committing a new table.
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
    if (f === "duplicate_cars.js") { window.DUPLICATE_CARS = {}; continue; }
    if (f === "llm_families_data.js") continue;
    load(f);
  }
  window.CarWeb.boot();
  console.log = quiet;
  return { store, nodes: window.CARDATA.nodes, links: window.CARDATA.links };
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
// Codes in a name: a word with a digit, or a Roman numeral.
const codes = s => new Set((String(s || "").match(/[A-Za-z]*\d+[A-Za-z\d]*|\b[IVX]{1,4}\b/g) || []).map(x => x.toLowerCase()));
const idOf = v => typeof v === "string" ? v : v.id;

(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/duplicate_cars.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
  const { nodes, links } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const live = n => n && !n.retired;
  const plateOf = id => { const n = byId.get(id); return n && n.familyOf ? n.familyOf : id; };
  const adj = new Map();
  links.forEach(l => {
    if (l.retired) return;
    const a = idOf(l.source), b = idOf(l.target);
    (adj.get(a) || adj.set(a, []).get(a)).push([l.type, b]);
    (adj.get(b) || adj.set(b, []).get(b)).push([l.type, a]);
  });
  const plates = new Map();
  nodes.forEach(f => {
    if (!live(f) || f.familyOf || !f.wp) return;
    const gens = (f.generations || []).map(id => byId.get(id)).filter(live);
    if (gens.length) (plates.get(norm(article(f.wp))) || plates.set(norm(article(f.wp)), []).get(norm(article(f.wp)))).push({ f, gens });
  });
  const rows = [];
  nodes.forEach(d => {
    if (!live(d) || d.type !== "model" || d.familyOf || d.concept || d.conceptOf || !d.wp) return;
    if ((d.generations || []).some(id => live(byId.get(id)))) return;
    for (const { f, gens } of plates.get(norm(article(d.wp))) || []) {
      if (f.id === d.id || f.make !== d.make) continue;
      const own = codes(d.label), plate = codes(f.label);
      const dc = new Set([...own].filter(x => !plate.has(x)));
      const hits = gens.filter(g => {
        const gc = new Set([...codes(g.label)].filter(x => !plate.has(x)));
        if (dc.size) return [...dc].some(x => gc.has(x));
        return Number.isFinite(d.year) && d.year === g.year && d.end === g.end && !(Number.isFinite(d.end) && d.end - d.year < 2);
      });
      if (hits.length !== 1) continue;
      const k = hits[0];
      // Every connection of its own is the generation's or the nameplate's too.
      const theirs = new Set([...(adj.get(k.id) || []), ...(adj.get(f.id) || [])].flatMap(([t, o]) => [t + "|" + o, t + "|" + plateOf(o)]));
      const ownLinks = (adj.get(d.id) || []).filter(([t, o]) => t !== "made" && t !== "name" && o !== k.id && o !== f.id &&
        !theirs.has(t + "|" + o) && !theirs.has(t + "|" + plateOf(o)));
      rows.push({ d, f, k, ownLinks });
      break;
    }
  });
  const need = [...new Set(rows.map(r => article(r.f.wp)))].filter(t => !(("text:" + t) in cache));
  for (let i = 0; i < need.length; i += 20) {
    const part = need.slice(i, i + 20);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1, prop: "revisions", rvprop: "content", rvslots: "main" });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const n0 = norms.get(t) || t; const p = pages.get(reds.get(n0) || n0); cache["text:" + t] = p && p.revisions ? p.revisions[0].slots.main.content : ""; });
    save();
  }
  const out = {}, report = [];
  rows.forEach(({ d, f, k, ownLinks }) => {
    const name = `${d.make} ${d.label}`, tag = `${d.id} (${name}) -> ${k.id} (${k.label})`;
    if (ownLinks.length) { report.push(`own      ${tag}: ${ownLinks.length} connection(s) of its own, e.g. ${ownLinks.slice(0, 3).map(([t, o]) => t + " " + ((byId.get(o) || {}).label || o)).join(", ")}`); return; }
    const flat = norm(cache["text:" + article(f.wp)] || "");
    const parts = String(d.label).replace(/\([^()]*\)/g, " ").split("/").map(s => s.trim()).filter(Boolean);
    const said = parts.some(p => flat.includes(norm(d.make + " " + p)) || (norm(p).length >= 5 && flat.includes(norm(p))));
    if (!said) { report.push(`unnamed  ${tag}: the article "${article(f.wp)}" does not give its name`); return; }
    out[d.id] = { into: k.id, name };
    report.push(`fold     ${tag}`);
  });
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/duplicate_cars.js"),
    "// Generated by scripts/duplicate_cars.js. Do not edit: change the rule.\nwindow.DUPLICATE_CARS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  process.stdout.write(`${rows.length} single cars that are a generation shown twice, ${lines.length} folded\n`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
