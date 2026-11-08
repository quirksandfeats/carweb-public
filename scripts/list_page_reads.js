#!/usr/bin/env node
// Writes app/list_page_reads.js: stored reads of a page that only lists other
// articles (isListOfArticles in app/llm_families.js), made before scans could tell.
// Such a read made each listed car a generation. Replay skips these reads; a new
// scan reads the listed pages instead. "own" counts the listed pages whose title
// carries the car's name: with none, the name is only another name for the listed
// cars (settleListPageNames). Reads after 3 Nov 2026 of a page the first list-page
// test already caught were made from the listed pages, and stay. Nothing here is
// written by hand.
//
//   node scripts/list_page_reads.js CACHE.json          fetches pages into CACHE.json
const fs = require("fs"), path = require("path"), https = require("https");
const ROOT = path.join(__dirname, "..");
const { JSDOM } = require(path.join(ROOT, "qa/jsdom/node_modules/jsdom"));
const LIST_LOGIC_SINCE = "2026-11-03T16:52:51Z";  // d9bf54a

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
    if (f === "list_page_reads.js") { window.LIST_PAGE_READS = {}; continue; }
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
// The first list-page test, before galleries were left out.
const firstTest = (LF, text) => !(String(text).length > 3000 || /\{\{\s*(?:infobox|main\b)/i.test(text)) && LF.isListOfArticles(text);
(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/list_page_reads.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const { LF, nodes } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, "app/llm_families.json"), "utf-8"));
  const gens = e => (e && e.proposal && e.proposal.generations) || [];
  const ids = new Set([...Object.keys(store.families || {}), ...Object.keys(store.recheck || {})].filter(id =>
    gens(store.families[id]).length > 1 || gens(store.recheck[id]).length > 1));
  const titleOf = id => (store.families[id] && store.families[id].sourceTitle) || (store.recheck[id] && store.recheck[id].sourceTitle);
  const need = [...new Set([...ids].map(titleOf).filter(Boolean))].filter(t => !(t in cache));
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    const r = await query({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", redirects: 1, titles: batch.join("|") });
    const q = r.query || {}, to = new Map([...(q.normalized || []), ...(q.redirects || [])].map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    batch.forEach(t => { let u = t; for (let k = 0; k < 4; k++) u = to.get(u) || u; const p = pages.get(u); cache[t] = p && p.revisions ? p.revisions[0].slots.main.content : null; });
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const out = {};
  for (const id of ids) {
    const title = titleOf(id), text = cache[title];
    if (!text || !LF.isListOfArticles(text)) continue;
    const reads = [];
    const take = e => { for (let x = e; x; x = x.appliedBefore) if (x.checkedAt && !(firstTest(LF, text) && x.checkedAt >= LIST_LOGIC_SINCE)) reads.push(x.checkedAt); };
    if (gens(store.families[id]).length > 1) take(store.families[id]);
    if (store.recheck[id]) take(store.recheck[id]);
    if (!reads.length) continue;
    const n = byId.get(id), core = norm((n && n.label) || title.replace(/^\S+\s/, ""));
    const listed = [...text.matchAll(/\[\[([^\]|#]+)|\{\{\s*main\s*\|([^}|]+)/gi)].map(m => (m[1] || m[2]).trim())
      .filter(t => !/^(?:file|image|category):/i.test(t) && norm(t) !== norm(title));
    const own = [...new Set(listed.filter(t => core && norm(t).includes(core)))];
    out[id] = { title, reads, own: own.length };
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/list_page_reads.js"),
    "// Generated by scripts/list_page_reads.js. Do not edit: change the rule.\nwindow.LIST_PAGE_READS = {\n" + lines.join("\n") + "\n};\n");
  console.log(`${ids.size} stored multi-generation reads, ${lines.length} of a list page, ${Object.values(out).filter(v => !v.own).length} with no page of their own name`);
  process.exit(0);
})();
function norm(s) { return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
