#!/usr/bin/env node
// Writes app/concept_cars.js: "generations" that are concept cars, show cars or
// prototypes. A generation is one when its code says so ("Concept", "prototypes",
// "Pilot series"), when its own infobox card gives that type, or when its section's
// first sentence calls it a concept car, show car, dream car or prototype. The load
// takes it out of the generation list and links it to the nameplate by name
// (applyConceptCars). Nothing here is written by hand.
//
//   node scripts/concept_cars.js CACHE.json          fetches articles into CACHE.json
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
  window.LLM_FAMILIES = Object.assign(JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8")), { __serverAvailable: false });
  for (const [, f] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    if (f === "concept_cars.js") { window.CONCEPT_CARS = {}; continue; }
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
const CODE_RE = /\b(?:concepts?|prototypes?|show car|dream car|pilot series)\b/i;
const KIND_RE = /\b(?:concept car|concept vehicle|show car|dream car|prototype|design study)\b/i;
(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/concept_cars.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const { LF, nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const live = n => n && !n.retired;
  const plates = nodes.filter(n => live(n) && n.type === "family" && n.wp && (n.generations || []).map(id => byId.get(id)).filter(live).length > 1);
  const bare = t => String(t || "").split("#")[0].trim();
  const need = [...new Set(plates.map(f => bare(f.wp)))].filter(t => !(t in cache) || (cache[t] && typeof cache[t] === "object"));
  const textOf = t => { const v = cache[t]; return v == null ? null : typeof v === "string" ? v : v.text || null; };
  const fetchList = need.filter(t => textOf(t) == null && !(t in cache));
  for (let i = 0; i < fetchList.length; i += 40) {
    const batch = fetchList.slice(i, i + 40);
    const r = await query({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", redirects: 1, titles: batch.join("|") });
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    batch.forEach(t => { let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u; const p = pages.get(u); cache[t] = p && p.revisions ? p.revisions[0].slots.main.content : null; });
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const out = {}, report = [];
  for (const f of plates) {
    const text = textOf(bare(f.wp));
    const secs = text ? LF.wikitextSections(text) : [];
    const gens = (f.generations || []).map(id => byId.get(id)).filter(live);
    for (const g of gens) {
      const code = String(g.label).startsWith(f.label + " ") ? g.label.slice(f.label.length + 1) : g.label;
      let why = CODE_RE.test(code) ? `its name, "${code}"` : null;
      // A section's words alone are trusted only for a car shown or built over a few
      // years: the Corniche's history opens with a 1939 prototype, and it ran 1971-1995.
      const brief = g.year == null || g.end == null || g.end - g.year <= 3;
      if (!why && text && brief) {
        const sec = LF.generationSection(text, secs, { code, yearStart: g.year, yearEnd: g.end });
        if (sec) {
          const body = text.slice((text.indexOf("\n", sec.at) + 1) || sec.stop, sec.stop);
          const head = body.split(/^={2,6}[^=]/m)[0];
          const type = (/\|\s*(?:type|class)\s*=\s*([^\n|]+)/i.exec(head) || [])[1] || "";
          // Its first sentence of prose, past templates and the card.
          const prose = head.replace(/\{\{(?:[^{}]|\{\{(?:[^{}]|\{\{[^{}]*\}\})*\}\})*\}\}/g, " ").replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, " ")
            .replace(/<ref[^>]*\/>|<ref[\s\S]*?<\/ref>/gi, " ").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/'{2,}/g, "").trim();
          const first = (prose.match(/^[\s\S]*?[.!?](?:\s|$)/) || [prose])[0].slice(0, 300);
          if (KIND_RE.test(type)) why = `its card's type, "${type.trim()}"`;
          else if (/\b(?:was|is|were)\s+(?:a|an|the)\s+(?:[\w-]+\s+){0,4}(?:concept car|concept vehicle|show car|dream car|prototype|design study)\b/i.test(first) &&
                   !/\b(?:production|went on sale|launched|introduced)\b/i.test(first)) why = `its section begins "${first.trim().slice(0, 120)}"`;
        }
      }
      if (!why) continue;
      // Shown under its own name: "Taigun Concept", not "Taigun Volkswagen Taigun Concept".
      let label = code;
      if (label.toLowerCase().startsWith(String(f.make).toLowerCase() + " ")) label = label.slice(f.make.length + 1);
      if (!label.toLowerCase().startsWith(String(f.label).toLowerCase())) label = `${f.label} ${label}`;
      out[g.id] = { label, why };
      report.push(`${f.make} ${f.label}: ${g.label} (${g.year}-${g.end}) -> "${label}" -- ${why}`);
    }
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/concept_cars.js"),
    "// Generated by scripts/concept_cars.js. Do not edit: change the rule.\nwindow.CONCEPT_CARS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  console.log(`${plates.length} nameplates read, ${lines.length} concept cars among their generations`);
  process.exit(0);
})();
