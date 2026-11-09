#!/usr/bin/env node
// Writes app/other_make_generations.js: "generations" that are another car. Each:
//   - another maker's car under a nameplate (the Fiat 128's "Zastava Skala", the Opel
//     Antara's "Holden Captiva 5"): a car of its own, merged into the node of that name
//     where the graph has one, else made a car of that make, on the platform of the
//     generation it was built beside. Not where the nameplate's article numbers it as a
//     generation in its heading ("Toyopet Crown - First generation").
//   - a platform with no years (the RSX's "Zero platform"): no car at all.
// Nothing here is written by hand.
//
//   node scripts/other_make_generations.js CACHE.json      fetches articles into CACHE.json
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
    if (f === "other_make_generations.js") { window.OTHER_MAKE_GENERATIONS = {}; continue; }
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
const words = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const norm = s => words(s).join("");
const NUMBERED = /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\s+(?:generation|series)\b|\bmark\s+(?:[ivx]+|\d+)\b/i;
(async () => {
  const cachePath = process.argv[2];
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const textOf = t => { const v = cache[t]; return v == null ? null : typeof v === "string" ? v : v.text || null; };
  const { LF, nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const live = n => n && !n.retired;
  // Makers with ten cars or more and a name of three letters or more: a lone "A" or
  // "New" is a split title, not a make.
  const carsOf = new Map();
  nodes.forEach(n => { if (live(n) && (n.type === "model" || n.type === "family") && !n.familyOf) carsOf.set(norm(n.make), (carsOf.get(norm(n.make)) || 0) + 1); });
  const makes = nodes.filter(n => n.type === "make" && live(n) && norm(n.label).length >= 3 && (carsOf.get(norm(n.label)) || 0) >= 10)
    .map(n => ({ n, w: words(n.label).join(" ") })).filter(m => m.w).sort((a, b) => b.w.length - a.w.length);
  const out = {}, report = [];
  for (const f of nodes.filter(n => live(n) && n.type === "family" && norm(n.label) !== norm(n.make))) {
    const gens = (f.generations || []).map(id => byId.get(id)).filter(live);
    if (gens.length < 2) continue;
    const text = textOf(String(f.wp || "").split("#")[0]);
    const secs = text ? LF.wikitextSections(text) : [];
    const own = words(f.make).join(" ");
    const codeOf = g => String(g.label).startsWith(f.label + " ") ? g.label.slice(f.label.length + 1) : g.label;
    for (const g of gens) {
      const code = codeOf(g);
      if (/\bplatform\b/i.test(code) && g.year == null) {
        out[g.id] = { action: "retire", why: `"${code}" is a platform` };
        report.push(`retire   ${f.make} ${f.label}: ${code} (a platform with no years)`); continue;
      }
      const cw = words(code).join(" ") + " ";
      const mk = makes.find(m => cw.startsWith(m.w + " ") && m.w !== own && !own.startsWith(m.w + " "));
      if (!mk) continue;
      // Numbered in the nameplate's own article: a generation under an earlier marque.
      if (text) {
        const sec = LF.generationSection(text, secs, { code, yearStart: g.year, yearEnd: g.end });
        const heading = sec ? text.slice(sec.at, (text.indexOf("\n", sec.at) + 1 || text.length + 1) - 1) : "";
        if (NUMBERED.test(heading)) { report.push(`keep     ${f.make} ${f.label}: ${code} (heading "${heading.replace(/=/g, "").trim()}")`); continue; }
      }
      const label = code.split(/\s+/).slice(mk.w.split(" ").length).join(" ").trim();
      if (!label) continue;
      // The node of that name, where the graph has one.
      const same = nodes.filter(n => live(n) && n.id !== g.id && (n.type === "model" || n.type === "family") && norm(n.make) === norm(mk.n.label) &&
        (norm(n.label) === norm(label) || norm(String(n.label).replace(/\s*\([^()]*\)\s*$/, "")) === norm(label.replace(/\s*\([^()]*\)\s*$/, ""))));
      // The generation it was built beside: the one whose years overlap it most.
      const ov = x => (x.year == null || g.year == null) ? -1 : Math.min(x.end == null ? 9999 : x.end, g.end == null ? 9999 : g.end) - Math.max(x.year, g.year);
      const base = gens.filter(x => x !== g && ov(x) >= 1 && !makes.some(m => (words(codeOf(x)).join(" ") + " ").startsWith(m.w + " ") && m.w !== own))
        .sort((a, b) => ov(b) - ov(a))[0] || null;
      if (same.length !== 1) { report.push(`not done ${f.make} ${f.label}: ${code} (no car of that name)`); continue; }
      let into = same[0];
      // A node on the nameplate's own article is that car under another badge (Fiat Daily).
      if (norm(String(into.wp || "").split("#")[0]) === norm(String(f.wp || "").split("#")[0])) { report.push(`keep     ${f.make} ${f.label}: ${code} (its node shares the article)`); continue; }
      // A generation of that car when the code numbers it: Suzuki Carry (Third generation).
      const ord = (/\(([a-z]+ generation)\)/i.exec(code) || [])[1];
      let donor = false;
      if (ord && into.type === "family") {
        const gg = (into.generations || []).map(id => byId.get(id)).filter(live).filter(x => norm(x.label).includes(norm(ord)));
        if (gg.length === 1) { into = gg[0]; donor = true; }
      }
      out[g.id] = { action: "merge", into: into.id, beside: !donor && base ? base.id : null };
      report.push(`merge    ${f.make} ${f.label}: ${code} -> ${into.make} ${into.label}` + (out[g.id].beside ? ` beside ${base.label}` : ""));
    }
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/other_make_generations.js"),
    "// Generated by scripts/other_make_generations.js. Do not edit: change the rule.\nwindow.OTHER_MAKE_GENERATIONS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  console.log(`${lines.length} rows`);
  process.exit(0);
})();
