#!/usr/bin/env node
// Writes app/article_ends.js: when each standalone car stopped being built, by
// lastBuiltOnCard in app/llm_families.js, for cars not re-scanned since that rule arrived.
// A scan applies the same rule by itself. Only the exceptions below are written by hand.
//
//   node scripts/article_ends.js CACHE.json          fetches articles into CACHE.json
//
// Read a sample of the changes against their articles before committing a new table.
const fs = require("fs"), path = require("path"), https = require("https");
const ROOT = path.join(__dirname, "..");
const { JSDOM } = require(path.join(ROOT, "qa/jsdom/node_modules/jsdom"));

// What the rule cannot tell from the field, each with why. A number or null sets the
// answer; "skip" leaves the car as it is.
const EXCEPTIONS = {
  "llm-related-bedford-astra": ["skip", "the Vauxhall Astra's card, for the whole nameplate"],
  "m-bentley-brooklands": [1998, "the 2008 coupe on the same page is a different car"],
  "m-datsun-type-17": ["skip", "a footnote gives a later end, from Nissan"],
  "m-ford-iosis": ["skip", "a run of unrelated concepts"],
  "m-volkswagen-id-space-vizzion": ["skip", "the 2023 line is the ID.7, which shares a word of its name"],
  "m-gaz-volga": ["skip", "the card lists only the M21's series"],
  "m-moskvitch-412": [1997, "the card's 2001 is the IZh-2715, a derived van"],
  "m-peugeot-406-coupe": ["skip", "the card's market lines are for the saloon"],
  "m-roewe-marvel-x": ["skip", "the 2026 line is the MG Marvel R, which shares a word of its name"],
  "m-talbot-14-45": ["skip", "the card lists chassis counts, which read as years"],
  "m-tata-manza": [2016, "shares the Indigo's page; the second-generation line is the Manza"],
  "m-zenvo-ts1-gt": ["skip", "the 2025 line is the TSR-GT, which shares a word of its name"],
};

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
    if (f === "article_ends.js") { window.ARTICLE_ENDS = {}; continue; }
    if (f === "llm_families_data.js") continue;
    load(f);
  }
  window.CarWeb.boot();
  console.log = quiet;
  return { LF: window.LlmFamilies, nodes: window.CARDATA.nodes };
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
async function fetchArticles(titles, cachePath) {
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const need = titles.filter(t => !(t in cache));
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const r = await post(new URLSearchParams({ action: "query", format: "json", formatversion: 2, prop: "revisions", rvprop: "content", rvslots: "main", redirects: 1, titles: batch.join("|") }).toString());
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    batch.forEach(t => {
      let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u;
      const p = pages.get(u);
      if (p && p.revisions) cache[t] = p.revisions[0].slots.main.content;
    });
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache;
}

async function redirectsOf(titles, cachePath) {
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const r = await post(new URLSearchParams({ action: "query", format: "json", formatversion: 2, redirects: 1, titles: titles.slice(i, i + 50).join("|") }).toString());
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    titles.slice(i, i + 50).forEach(t => { let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u; if (u !== t) out[t] = u; });
    await new Promise(z => setTimeout(z, 300));
  }
  fs.writeFileSync(cachePath, JSON.stringify(out));
  return out;
}

(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/article_ends.js CACHE.json"); process.exit(1); }
  const { LF, nodes } = bootApp();
  const cars = nodes.filter(n => n.type === "model" && !n.familyOf && !n.retired && n.wp && n.year != null && !n.future);
  const articles = await fetchArticles([...new Set(cars.map(n => n.wp))], cachePath);
  const BOX = /\{\{\s*infobox[ _](?:automobile|car)\b/gi;
  const pages = await redirectsOf([...new Set(cars.map(n => n.wp))], cachePath + ".redirects");
  const out = {};
  for (const n of cars) {
    const ex = EXCEPTIONS[n.id];
    if (ex) { if (ex[0] !== "skip") out[n.id] = ex[0]; continue; }
    const text = articles[n.wp];
    if (!text) continue;
    const clean = text.replace(/<!--[\s\S]*?-->/g, "");
    const boxes = [...clean.matchAll(BOX)];
    if (!boxes.length) continue;
    const full = `${n.make || ""} ${n.label}`.trim().toLowerCase(), title = (pages[n.wp] || n.wp).toLowerCase();
    if (!title.includes(n.label.toLowerCase()) && !full.includes(title)) continue;  // an article about another car
    const shown = n.shownEndFromArticle ? n.handover : n.end;
    const unsure = shown == null || shown === n.year;
    // A page with several cards is a nameplate's, so only a car with no real end year takes it.
    if (boxes.length > 1 && !unsure) continue;
    const field = box => {
      const card = clean.slice(box.index, box.index + 8000);
      const end = m => { const r = new RegExp("\\|\\s*" + m + "\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*[A-Za-z_ ]+\\s*=|\\n\\}\\})", "i").exec(card); return r ? r[1] : null; };
      return end("production") || end("model_years");
    };
    const said = LF.lastBuiltOnCard(boxes.map(field).filter(Boolean).join("\n"), n.make, n.label);
    if (!LF.cardFitsCar(said, n)) continue;
    // A year either way is usually production against model year.
    if (said.end === shown) continue;
    if (!unsure && said.end != null && Math.abs(said.end - shown) < 2) continue;
    // A shorter run needs a card with no other car on it.
    if (!unsure && said.end != null && said.end < shown && !said.sure) continue;
    out[n.id] = said.end;
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${out[k] === null ? "null" : out[k]},`);
  fs.writeFileSync(path.join(ROOT, "app/article_ends.js"),
    "// Generated by scripts/article_ends.js. Do not edit: change the rule or its exceptions.\nwindow.ARTICLE_ENDS = {\n" + lines.join("\n") + "\n};\n");
  console.log(`${lines.length} cars, ${Object.values(out).filter(v => v === null).length} still built`);
  process.exit(0);
})();
