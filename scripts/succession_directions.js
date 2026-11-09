#!/usr/bin/env node
// Writes app/succession_directions.js: for each pair of cars with a succession drawn
// both ways, which way the articles state it. Each car's infobox cards (its own article,
// its generations' articles, and the articles its nameplate's sections point to with
// {{Main}}) give predecessor and successor fields. A direction counts when the
// older car's successor or the newer car's predecessor names the other; a region the
// field gives with it ("Dodge Neon (Mexico)") is kept. A car and its own nameplate or
// generation is "self": no succession at all. Only the exceptions below are by hand.
//
//   node scripts/succession_directions.js CACHE.json      fetches articles into CACHE.json
//
// Read every pair's evidence before committing a new table.
const fs = require("fs"), path = require("path"), https = require("https");
const ROOT = path.join(__dirname, "..");
const { JSDOM } = require(path.join(ROOT, "qa/jsdom/node_modules/jsdom"));

// What the fields cannot tell, each with why: [self reason or null, stated directions].
const EXCEPTIONS = {
  "fam-volkswagen-polo|m-volkswagen-derby": { self: "the Derby is the Polo's saloon: its second generation is the Polo Mk2's article, and the Derby article names no predecessor or successor", stated: [], regions: {} },
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
    if (f === "succession_directions.js") { window.SUCCESSION_DIRECTIONS = {}; continue; }
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
// ---- infobox reading ----
function matchBraces(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    if (s.startsWith("{{", j)) { depth++; j += 2; continue; }
    if (s.startsWith("}}", j)) { depth--; j += 2; if (depth === 0) return j; continue; }
    j++;
  }
  return s.length;
}
function splitParams(body) {
  const parts = []; let cur = "", d1 = 0, d2 = 0;
  for (let i = 0; i < body.length;) {
    if (body.startsWith("{{", i)) { d1++; cur += "{{"; i += 2; continue; }
    if (body.startsWith("}}", i)) { d1--; cur += "}}"; i += 2; continue; }
    if (body.startsWith("[[", i)) { d2++; cur += "[["; i += 2; continue; }
    if (body.startsWith("]]", i)) { d2--; cur += "]]"; i += 2; continue; }
    const c = body[i];
    if (c === "|" && d1 === 0 && d2 === 0) { parts.push(cur); cur = ""; } else cur += c;
    i++;
  }
  parts.push(cur); return parts;
}
function infoboxes(text) {
  const out = [];
  if (!text) return out;
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of text.matchAll(/\{\{\s*Infobox[ _]/gi)) {
    const st = m.index, en = matchBraces(text, st);
    const ps = splitParams(text.slice(st + 2, en - 2)), kv = {};
    for (const p of ps.slice(1)) { const k = p.indexOf("="); if (k > 0) kv[p.slice(0, k).trim().toLowerCase()] = p.slice(k + 1).trim(); }
    out.push({ kv });
  }
  return out;
}
// The links a field gives, each with the region written beside it: "(Mexico)".
function fieldLinks(v) {
  const out = [];
  if (!v) return out;
  const re = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(v))) {
    const after = v.slice(re.lastIndex).split(/\[\[|<br\s*\/?>|\n|\{\{/i)[0];
    const p = /^\s*\(([^()]+)\)/.exec(after);
    let region = p ? p[1].split(/[,;]/)[0].trim() : null;
    if (region && (/\d/.test(region) || !/^[A-Z][A-Za-z .'-]+$/.test(region) || /\b(?:model|version|generation|series|platform|facelift)\b/i.test(region))) region = null;
    out.push({ title: m[1].trim(), frag: m[2] ? m[2].slice(1) : null, region });
  }
  return out;
}
(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/succession_directions.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const { nodes, links } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const idOf = v => (typeof v === "string" ? v : v && v.id);
  // The pairs: a succession the load retired against its opposite, and a succession
  // drawn against the generation chain of one nameplate.
  const pairs = new Map();
  const add = (a, b, kind) => { const k = [a, b].sort().join("|"); if (!pairs.has(k)) pairs.set(k, { a, b, kind }); };
  links.forEach(l => { if (l.type === "succession" && l.retired && /both directions/.test(l.retiredReason || "")) add(idOf(l.source), idOf(l.target), "both"); });
  const live = t => new Set(links.filter(l => l.type === t && !l.retired).map(l => idOf(l.source) + ">" + idOf(l.target)));
  const gs = live("gensucc");
  live("succession").forEach(k => { const [a, b] = k.split(">"); if (gs.has(b + ">" + a)) add(a, b, "chain"); });
  const gensOf = id => ((byId.get(id) || {}).generations || []).map(g => byId.get(g)).filter(g => g && !g.retired);
  const follow = n => { let h = 0; while (n && n.retired && n.supersededBy && h++ < 6) n = byId.get(n.supersededBy); return n; };
  // Articles: each car's own, its generations', and its nameplate article's {{Main}} pages.
  const bare = t => String(t || "").split("#")[0].trim();
  const want = new Set();
  const own = id => { const n = byId.get(id); const out = [bare(n.wp)]; gensOf(id).forEach(g => out.push(bare(g.wp))); return out.filter(Boolean); };
  pairs.forEach(p => [p.a, p.b].forEach(id => own(id).forEach(t => want.add(t))));
  async function fetchAll(titles) {
    const need = [...titles].filter(t => !(t in cache));
    for (let i = 0; i < need.length; i += 40) {
      const batch = need.slice(i, i + 40);
      const r = await query({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", redirects: 1, titles: batch.join("|") });
      const q = r.query || {}, norm = new Map((q.normalized || []).map(x => [x.from, x.to]));
      const red = new Map((q.redirects || []).map(x => [x.from, x]));
      const pages = new Map((q.pages || []).map(p => [p.title, p]));
      batch.forEach(t => {
        let u = norm.get(t) || t, frag = null;
        if (red.has(u)) { frag = red.get(u).tofragment || null; u = red.get(u).to; }
        const p = pages.get(u);
        cache[t] = { final: u, frag, text: p && p.revisions ? p.revisions[0].slots.main.content : null };
      });
      await new Promise(z => setTimeout(z, 400));
    }
  }
  await fetchAll(want);
  const mainsOf = t => [...String((cache[t] || {}).text || "").matchAll(/\{\{\s*(?:main|main article|further)\s*\|([^}]+)\}\}/gi)]
    .flatMap(m => m[1].split("|")).map(x => x.trim()).filter(x => x && !/=/.test(x)).map(bare);
  const mains = new Set();
  pairs.forEach(p => [p.a, p.b].forEach(id => { if (byId.get(id).type === "family") mainsOf(bare(byId.get(id).wp)).forEach(t => mains.add(t)); }));
  await fetchAll(mains);
  // Every link a field gives is resolved through redirects too.
  const fieldTitles = new Set();
  Object.values(cache).forEach(v => infoboxes(v && v.text).forEach(b => ["predecessor", "successor"].forEach(f => fieldLinks(b.kv[f]).forEach(x => fieldTitles.add(x.title)))));
  const needR = [...fieldTitles].filter(t => !(("R:" + t) in cache) && !(t in cache));
  for (let i = 0; i < needR.length; i += 50) {
    const batch = needR.slice(i, i + 50);
    const r = await query({ action: "query", redirects: 1, titles: batch.join("|") });
    const q = r.query || {}, norm = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const red = new Map((q.redirects || []).map(x => [x.from, x]));
    batch.forEach(t => { let u = norm.get(t) || t, frag = null; if (red.has(u)) { frag = red.get(u).tofragment || null; u = red.get(u).to; } cache["R:" + t] = { final: u, frag }; });
    await new Promise(z => setTimeout(z, 300));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const fin = t => { t = bare(t); if (!t) return null; const c = cache[t] || cache["R:" + t]; return c ? c.final : t; };
  const titlesOf = id => new Set([fin(byId.get(id).wp), ...gensOf(id).map(g => fin(g.wp))].filter(Boolean));
  const namesOf = id => { const n = byId.get(id); return [fin(n.wp), `${n.make || ""} ${n.label}`.trim()].filter(Boolean); };
  const prefixed = (t, P) => P.some(p => t === p || t.startsWith(p + " ("));
  const articlesOf = id => {
    const n = byId.get(id), out = new Set(own(id).map(t => fin(t) || t));
    if (n.type === "family") mainsOf(bare(n.wp)).forEach(t => out.add(fin(t) || t));
    return [...out];
  };
  const textOf = t => { const hit = Object.entries(cache).find(([k, v]) => !k.startsWith("R:") && v && v.final === t && v.text); return hit ? hit[1].text : null; };
  // What i's articles say of j: [{field, region, where}].
  // Which of a car's generations an article or a link is about: by its own page, else
  // by the words of its code in the title or the section the link points to ("Continental
  // Mark II" is the Mark series' Mark II). The car itself when none or several fit.
  const words = t => String(t || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // A link names a generation by its page or its section anchor, never by words of the
  // page title alone ("Toyota Corolla (E210)" is not the Auris E210). A link to some page
  // that is neither the nameplate's own nor a generation's is null: the article names a
  // generation the graph does not hold (the E-Class C207), so no generation is drawn.
  function genFor(id, title, frag, titleWords) {
    const n = byId.get(id), gens = gensOf(id);
    let hit = gens.filter(g => fin(g.wp) === title && fin(g.wp) !== fin(n.wp));
    if (hit.length === 1) return hit[0].id;
    const said = new Set(words(frag).concat(titleWords ? words(title) : []));
    hit = gens.filter(g => {
      const code = words(String(g.label).startsWith(n.label + " ") ? g.label.slice(n.label.length + 1) : g.label);
      return code.length && code.every(w => said.has(w)) && !code.every(w => words(n.label).includes(w));
    });
    if (hit.length === 1) return hit[0].id;
    return titleWords || title === fin(n.wp) || !gens.length ? id : null;
  }
  // An article both cars hold (the Derby nameplate holds the Polo Mk2's) says nothing
  // of one to the other: its fields are about the generation they share.
  function said(i, j) {
    const Tj0 = titlesOf(j), Ti = titlesOf(i), shared = new Set([...Ti].filter(t => Tj0.has(t)));
    const T = new Set([...Tj0].filter(t => !shared.has(t))), Pj = namesOf(j), Pi = namesOf(i), out = [];
    // A page the nameplate article points to with {{Main}} speaks for the car only when it
    // is one of its own generations, and not the other car's page: the CLK article's
    // pointer to the E-Class C207, and the Auris's to the Corolla (E210), are not theirs.
    const ownPages = new Set(own(i).map(t => fin(t) || t));
    const usable = t => !shared.has(t) && (ownPages.has(t) || (!Tj0.has(t) && genFor(i, t, null, true) !== i));
    for (const art of articlesOf(i).filter(usable)) {
      for (const b of infoboxes(textOf(art))) for (const f of ["predecessor", "successor"]) for (const x of fieldLinks(b.kv[f])) {
        const t = fin(x.title);
        if (!t) continue;
        const hit = T.has(t) || prefixed(t, Pj);
        if (!hit) continue;
        if (Ti.has(t) || (prefixed(t, Pi) && !T.has(t))) continue;   // the field is about this car itself
        const r = cache["R:" + x.title] || cache[x.title] || {};
        out.push({ field: f, region: x.region, where: `${art}: ${f} [[${x.title}]]` + (x.region ? ` (${x.region})` : ""),
          at: genFor(i, art, null, true), names: genFor(j, t, x.frag || r.frag || null, false) });
      }
    }
    return out;
  }
  function selfReason(a, b) {
    const A = byId.get(a), B = byId.get(b), fa = follow(A), fb = follow(B);
    const wa = fin(A.wp), wb = fin(B.wp);
    if (wa && wa === wb) return "same article";
    if (A.familyOf && A.familyOf === B.familyOf) return "two generations of one nameplate";
    for (const [x, y, X] of [[A, B, fa], [B, A, fb]]) {
      if (y.type === "family" && (x.familyOf === y.id || (X && X.familyOf === y.id))) return "a generation of the other nameplate";
      const wx = fin(x.wp), wy = fin(y.wp);
      if (wx && wy && y.type === "family" && (wx.startsWith(wy + " (") || new RegExp("^" + wy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " [A-Z0-9][A-Z0-9/]*$").test(wx))) return "the other nameplate plus a code";
    }
    return null;
  }
  const out = {};
  for (const [k, p] of pairs) {
    if (EXCEPTIONS[k]) { out[k] = Object.assign({ evidence: [] }, EXCEPTIONS[k]); continue; }
    const { a, b } = p, self = selfReason(a, b);
    const ab = said(a, b), ba = said(b, a);
    // a -> b: a's successor names b, or b's predecessor names a.
    const fwd = ab.filter(x => x.field === "successor").concat(ba.filter(x => x.field === "predecessor"));
    const back = ba.filter(x => x.field === "successor").concat(ab.filter(x => x.field === "predecessor"));
    const stated = [], regions = {}, pairsOf = {};
    // Each statement as the generations it joins, older first: a successor field is said
    // by the older car, a predecessor field by the newer one.
    const note = (dir, ev, older) => {
      if (!ev.length) return;
      stated.push(dir);
      const r = ev.map(x => x.region).filter(Boolean);
      if (r.length && r.length === ev.length) regions[dir] = r[0];
      const seen = new Set();
      pairsOf[dir] = ev.map(x => x.field === "successor" ? [x.at, x.names] : [x.names, x.at])
        .filter(([x, y]) => x && y && x !== y && !seen.has(x + ">" + y) && seen.add(x + ">" + y));
    };
    if (!self) { note(a + ">" + b, fwd); note(b + ">" + a, back); }
    const sharesGeneration = [...titlesOf(a)].some(t => titlesOf(b).has(t)) && byId.get(a).type === "family" && byId.get(b).type === "family";
    out[k] = { self: self || (!stated.length && sharesGeneration ? "the nameplates share a generation article" : null),
      stated, regions, pairs: pairsOf, evidence: [...fwd, ...back].map(x => x.where).slice(0, 6) };
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/succession_directions.js"),
    "// Generated by scripts/succession_directions.js. Do not edit: change the rule.\nwindow.SUCCESSION_DIRECTIONS = {\n" + lines.join("\n") + "\n};\n");
  const by = {}; Object.values(out).forEach(v => { const c = v.self ? "self" : v.stated.length === 2 ? "both" : v.stated.length ? "one" : "neither"; by[c] = (by[c] || 0) + 1; });
  console.log(`${pairs.size} pairs:`, JSON.stringify(by));
  process.exit(0);
})();
