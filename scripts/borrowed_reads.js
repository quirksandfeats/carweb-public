#!/usr/bin/env node
// Writes app/borrowed_reads.js: stored reads that split a car into the generations
// of another car's article. The car's own name has no article: Wikipedia sends
// "Toyota Lexcen" to "Holden Commodore (VR)", and "Vauxhall Midi" to "Isuzu Fargo".
// The read took that article's generations under the car's name, though another
// car in the graph already owns the article: a generation of another nameplate.
// Replay skips these reads; the car stays one car, on the same platform as that
// generation. Nothing here is written by hand.
//
//   node scripts/borrowed_reads.js CACHE.json          fetches titles into CACHE.json
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
    if (f === "borrowed_reads.js") { window.BORROWED_READS = {}; continue; }
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
  if (!cachePath) { console.error("usage: node scripts/borrowed_reads.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const { LF, nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, "app/llm_families.json"), "utf-8"));
  const gens = e => (e && e.proposal && e.proposal.generations) || [];
  const split = e => e && e.status === "confirmed" && gens(e).length > 1;
  const ids = [...new Set([...Object.keys(store.families || {}), ...Object.keys(store.recheck || {})])]
    .filter(id => split(store.families[id]) || split(store.recheck[id]));
  const titleOf = id => (split(store.families[id]) && store.families[id].sourceTitle) || (store.recheck[id] && store.recheck[id].sourceTitle);
  const bare = t => String(t || "").split("#")[0].trim();
  const plain = s => String(s || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
  const ownName = n => `${n.make || ""} ${plain(n.label)}`.trim();
  // A title carries a car's name when it starts with it, with or without the make
  // ("Mazda2" carries "Mazda 2"); a name in parts ("Fit/Jazz") by any part.
  const carriesName = (title, n) => {
    const t = bare(title), rest = t.toLowerCase().startsWith(n.make.toLowerCase() + " ") ? t.slice(n.make.length + 1) : t;
    return plain(n.label).split("/").map(norm).filter(Boolean).some(w =>
      norm(rest).startsWith(w) || norm(t).startsWith(w) || norm(t).startsWith(norm(n.make) + w));
  };
  // The candidates: a car whose read's title does not carry its name.
  const cands = ids.map(id => byId.get(id)).filter(n => n && !n.retired && n.make && titleOf(n.id) && !carriesName(titleOf(n.id), n));
  // Where the car's own name lands on Wikipedia.
  const need = [...new Set(cands.map(ownName))].filter(t => !(t in cache));
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    const r = await query({ action: "query", redirects: 1, titles: batch.join("|") });
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    batch.forEach(t => { let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u; const p = pages.get(u); cache[t] = !p || p.missing ? null : u; });
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const out = {}, report = [];
  for (const n of cands) {
    const title = bare(titleOf(n.id)), key = LF.articleKeyOf(title), lands = cache[ownName(n)];
    // The car's name must have no article of its own: it is missing, or it lands on
    // a page that does not carry it ("Toyota Lexcen" lands on "Holden Commodore").
    if (lands != null && carriesName(lands, n)) { report.push(`own page   ${n.id}: ${ownName(n)} -> ${lands} (read ${title})`); continue; }
    // And a generation of another nameplate must own that article: that nameplate
    // holds its read. A car whose borrowed article is a nameplate's own page is often
    // the only split of it (the TownAce holds the LiteAce's generations); that wants a
    // rename, not a skip, and is only reported.
    const others = nodes.filter(o => o && !o.retired && o.id !== n.id && o.familyOf !== n.id &&
      (o.type === "model" || o.type === "family") && !o.nameOnly && LF.articleKeyOf(o.wp) === key);
    const gensOf = others.filter(o => o.familyOf && byId.get(o.familyOf) && !byId.get(o.familyOf).retired);
    gensOf.sort((a, b) => (norm(`${b.make || ""} ${b.label}`) === norm(title)) - (norm(`${a.make || ""} ${a.label}`) === norm(title)) ||
      String(a.id).localeCompare(String(b.id)));
    if (!gensOf.length) { report.push(`${others.length ? "plate page" : "no owner  "} ${n.id}: ${ownName(n)} (read ${title})`); continue; }
    others.splice(0, others.length, ...gensOf);
    const reads = [];
    for (const e of [store.families[n.id], store.recheck[n.id]]) for (let x = e; x; x = x.appliedBefore)
      if (x.checkedAt && bare(x.sourceTitle) && LF.articleKeyOf(bare(x.sourceTitle)) === key && !reads.includes(x.checkedAt)) reads.push(x.checkedAt);
    if (!reads.length) continue;
    out[n.id] = { title, reads: reads.sort(), owner: others[0].id };
    report.push(`borrowed   ${n.id}: ${ownName(n)} -> ${title} (${lands ? "redirect" : "no page"}); owner ${others[0].id} ${others[0].label}`);
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/borrowed_reads.js"),
    "// Generated by scripts/borrowed_reads.js. Do not edit: change the rule.\nwindow.BORROWED_READS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.BORROWED_REPORT) fs.writeFileSync(process.env.BORROWED_REPORT, report.sort().join("\n") + "\n");
  console.log(`${ids.length} stored splits, ${cands.length} read a page without their name, ${lines.length} of another car's article`);
  process.exit(0);
})();
function norm(s) { return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
