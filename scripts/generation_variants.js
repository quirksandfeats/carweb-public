#!/usr/bin/env node
// Writes app/generation_variants.js: "generations" that are a facelift or phase of
// another generation, or one of its body styles or electric or hybrid versions, by the
// words of their code ("Facelift", "Phase II", "Pre-facelift", "Roadster", "GT",
// "Electric"). Each folds into the generation it belongs to: a facelift into its own
// base code ("Astra J (facelift)" into the Astra J) or the generation before it; a
// version into the generation whose years it shares. Where every generation of a
// nameplate is such a split (Peugeot 106 Phase I and II), the first is the one car and
// takes the nameplate's name. Nothing here is written by hand; it reads no article.
//
//   node scripts/generation_variants.js
const fs = require("fs"), path = require("path");
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
    if (f === "generation_variants.js") { window.GENERATION_VARIANTS = {}; continue; }
    if (f === "llm_families_data.js") continue;
    load(f);
  }
  window.CarWeb.boot();
  console.log = quiet;
  return { LF: window.LlmFamilies, nodes: window.CARDATA.nodes, links: window.CARDATA.links };
}

const FACE_RE = /\b(?:face-?lift(?:ed)?|pre-?\s?facelift|phase\s*(?:i{1,3}|[1-3])|restyl\w*)\b/i;
const BODY = new Set(["roadster", "coupe", "coupé", "convertible", "cabriolet", "cabrio", "spider", "spyder", "estate", "wagon", "van",
  "ute", "pickup", "traveller", "tourer", "sedan", "saloon", "hatchback", "berlinetta", "3p", "5p", "gt", "gts", "sport", "sports",
  "cross", "targa", "trasformabile", "delivery", "tv", "v8", "and"]);
const POWER = new Set(["hybrid", "electric", "ev", "plug", "in", "phev", "diesel"]);
const words = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\([^()]*\)/g, " ")
  .split(/[^a-z0-9é]+/).filter(Boolean);
(async () => {
  const { nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const live = n => n && !n.retired;
  const out = {}, report = [];
  const makeNames = nodes.filter(n => n.type === "make" && live(n)).map(n => words(n.label).join(" ")).filter(Boolean);
  for (const f of nodes.filter(n => live(n) && n.type === "family" && !/\bengine\b/i.test(n.label))) {
    const gens = (f.generations || []).map(id => byId.get(id)).filter(live).sort((a, b) => (a.year == null ? 1e9 : a.year) - (b.year == null ? 1e9 : b.year));
    if (gens.length < 2) continue;
    const skip = new Set(words(f.label).concat(words(f.make)));
    const codeOf = g => String(g.label).startsWith(f.label + " ") ? g.label.slice(f.label.length + 1) : g.label;
    // Another maker's car under this nameplate (the Xpander's Nissan Livina) is no home
    // for a facelift; that is a question of its own.
    const otherMake = g => { const w = words(codeOf(g)).join(" ") + " "; return makeNames.some(m => w.startsWith(m + " ") && m !== words(f.make).join(" ")); };
    const kindOf = g => {
      const c = codeOf(g);
      if (FACE_RE.test(c)) return "phase";
      const w = words(c).filter(x => !skip.has(x) && !/^(?:19|20)\d\d$/.test(x));
      if (!w.length) return null;
      if (w.every(x => BODY.has(x) || POWER.has(x))) return "variant";
      return null;
    };
    const kinds = new Map(gens.map(g => [g.id, kindOf(g)]));
    const flagged = gens.filter(g => kinds.get(g.id));
    if (!flagged.length) continue;
    const strip = c => c.replace(FACE_RE, " ").replace(/\((?:\s|[-–])*\)/g, " ").replace(/\b(?:19|20)\d\d\s*[-–]\s*(?:(?:19|20)\d\d)?/g, " ")
      .replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    const baseWords = g => words(strip(codeOf(g))).filter(x => !skip.has(x));
    // The first phase ("Phase I", "Pre-facelift") is the generation the later ones join.
    const firstPhase = flagged.filter(g => /pre-?\s?facelift|phase\s*(?:i|1)\b|\boriginal\b/i.test(codeOf(g)));
    const homes = gens.filter(g => !otherMake(g) && (!kinds.get(g.id) || firstPhase.includes(g)));
    // Where every generation is a split, the first that is not another maker's is the car.
    const anchor = !gens.some(g => !kinds.get(g.id) && !otherMake(g)) ? gens.find(g => !otherMake(g)) : null;
    const genLike = g => /\d|\b(?:i{1,3}|iv|v|vi{0,3}|generation|series|mark|mk)\b/i.test(codeOf(g).replace(/\b(?:19|20)\d\d\b/g, " "));
    const overlap = (x, y) => (x.year == null || y.year == null) ? -1 : Math.min(x.end == null ? 9999 : x.end, y.end == null ? 9999 : y.end) - Math.max(x.year, y.year);
    const renamed = new Set();
    for (const g of flagged) {
      if (g === anchor || firstPhase.includes(g)) continue;
      const kind = kinds.get(g.id);
      let into = null;
      if (kind === "phase") {
        const base = baseWords(g);
        const pool = homes.filter(p => p !== g && p.year != null && g.year != null && p.year <= g.year);
        into = (base.length && pool.find(p => baseWords(p).join(" ") === base.join(" "))) ||
          (firstPhase.length ? pool.filter(p => firstPhase.includes(p)).pop() : null) ||
          (pool.length ? (p => (!base.length || baseWords(p).some(w => base.includes(w))) ? p : null)(pool[pool.length - 1]) : null) || null;
      } else {
        const holds = p => p.year != null && g.year != null && p.year <= g.year && (p.end == null || p.end >= g.year);
        into = homes.filter(p => p !== g && genLike(p) && overlap(p, g) >= 2)
          .sort((x, y) => holds(y) - holds(x) || overlap(y, g) - overlap(x, g) || x.year - y.year)[0] || null;
      }
      // The nameplate's one car takes a later phase, or a version built alongside it (the
      // Dodge Avenger's 1995 coupe and 2008 sedan are two cars).
      if (!into && anchor && anchor !== g && (kind === "phase" || overlap(anchor, g) >= 2)) into = anchor;
      if (!into) continue;
      out[g.id] = { into: into.id, kind, label: codeOf(g) };
      report.push(`${f.make} ${f.label}: ${kind} "${codeOf(g)}" (${g.year}-${g.end}) -> ${into.label}`);
      if (into === anchor || firstPhase.includes(into)) renamed.add(into);
    }
    renamed.forEach(t => {
      const rest = baseWords(t);
      const label = rest.length && t !== anchor ? `${f.label} ${strip(codeOf(t)).replace(new RegExp("^" + f.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*", "i"), "")}`.trim() : f.label;
      out[t.id] = Object.assign(out[t.id] || {}, { rename: label, anchorLabel: codeOf(t), kind: kinds.get(t.id) || "phase" });
      report.push(`${f.make} ${f.label}: "${t.label}" stays, renamed "${label}"`);
    });
  }
  // An anchor's own row carries only the rename; it folds into nothing.
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/generation_variants.js"),
    "// Generated by scripts/generation_variants.js. Do not edit: change the rule.\nwindow.GENERATION_VARIANTS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  console.log(`${lines.length} rows`);
  process.exit(0);
})();
