#!/usr/bin/env node
// Writes app/duplicate_cars.js: single cars that are a generation of a nameplate
// shown twice. A row is written for a car standing on its own (no generations) when
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
//   - the nameplate's article gives its name (a name of the car, not a word of it).
// The owner's ruling (10 Nov 2026), for cars with connections of their own too:
// an enthusiast wants each car once, with all it is known for. Its connections
// go to the generation with it, and its name stays as another name of it. Nothing here is
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
  return { store, nodes: window.CARDATA.nodes, links: window.CARDATA.links, LF: window.LlmFamilies };
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
  const { nodes, links, LF } = bootApp();
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
  const rows = [], via = new Map(), trimAsk = [];
  // Where each single car's own name lands: a trim's title often redirects to a
  // section of its nameplate's article that carries its year ("Nissan Rogue
  // Plug-in Hybrid" -> "Rogue Plug-in Hybrid (2025)"), a better year than one
  // copied from the nameplate.
  const ownTitles = nodes.filter(d => live(d) && d.type === "model" && !d.familyOf && d.wp && plates.has(norm(article(d.wp))))
    .map(d => `${d.make} ${d.label}`).filter(t => !(("look:" + t) in cache));
  for (let i = 0; i < ownTitles.length; i += 50) {
    const part = ownTitles.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1 });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const n0 = norms.get(t) || t, rd = reds.get(n0), to = rd ? rd.to : n0, p = pages.get(to);
      cache["look:" + t] = { to, fragment: rd && rd.tofragment || null, missing: !p || !!p.missing }; });
    save();
  }
  const sectionYear = d => { const at = cache["look:" + `${d.make} ${d.label}`]; const m = at && at.fragment && /\b(19\d\d|20\d\d)\b/.exec(at.fragment); return m ? +m[1] : null; };
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
      // A trim or version of the nameplate's own name ("Buick Roadmaster
      // Convertible", "Suzuki e Every"), or a name a generation's own infobox gives
      // it ("Toyota Echo" for the Yaris XP10): the generation in production in the
      // car's first year. The owner's ruling 1 (8 Nov 2026): a trim or version with
      // no article of its own is part of the generation it belongs to.
      if (!hits.length && !dc.size) {
        const words = x => String(x).normalize("NFKD").toLowerCase().replace(/\([^()]*\)/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
        const pw = words(f.label), dw = words(d.label);
        const trim = dw.length > pw.length && dw.some((w, i) => pw.every((p, j) => dw[i + j] === p));
        const named = g => (LF.aliasesFor(g.id) || []).some(a => { const x = norm(String(a).replace(/\([^()]*\)/g, " ")); return x === norm(d.make + " " + d.label) || x === norm(d.label); });
        // Years copied from the nameplate's article say nothing of which generation
        // (the Corolla Axio had the Corolla's 1966).
        const sy = sectionYear(d), y = sy || d.year;
        const plateYears = !sy && (d.year === f.year || (Number.isFinite(d.end) && d.end === f.end && d.year <= f.year + 1));
        const inRun = g => !plateYears && Number.isFinite(y) && Number.isFinite(g.year) && g.year <= y && y <= (Number.isFinite(g.end) ? g.end : 9999);
        // A name that is part of the nameplate's own ("Cayman" of the "Boxster and
        // Cayman") names every generation, not one.
        const inPlate = dw.every(w => pw.includes(w));
        const viaName = inPlate ? [] : gens.filter(named);
        if (viaName.length !== 1 && trim) trimAsk.push(d);
        hits.push(...(viaName.length === 1 ? viaName : trim ? gens.filter(inRun) : []));
        if (hits.length === 1) via.set(d.id, viaName.length === 1 ? "named" : "trim");
      }
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
    const flat = norm(cache["text:" + article(f.wp)] || "");
    const parts = String(d.label).replace(/\([^()]*\)/g, " ").split("/").map(s => s.trim()).filter(Boolean);
    const said = parts.some(p => flat.includes(norm(d.make + " " + p)) || (norm(p).length >= 5 && flat.includes(norm(p))));
    if (!said) { report.push(`unnamed  ${tag}: the article "${article(f.wp)}" does not give its name`); return; }
    out[d.id] = { into: k.id, name };
    report.push(`fold     ${tag}` + (via.has(d.id) ? ` [${via.get(d.id)}]` : "") + (ownLinks.length ? `, bringing ${ownLinks.length} connection(s): ${ownLinks.slice(0, 4).map(([t, o]) => t + " " + ((byId.get(o) || {}).label || o)).join(", ")}` : ""));
  });
  // A nameplate shown twice, generation by generation: the Ford Falcon (Australia)
  // read from its article beside the Falcon of the build data, whose generations
  // have articles of their own. Two nameplates of one make and one name (brackets
  // aside) whose generations' codes meet for at least three and for most of the
  // smaller. The one whose generations have more articles of their own is kept and
  // takes the other's article when its own is a list page. Each generation of the
  // other goes to the kept generation of its code; one with none goes to the car
  // its own title is the article of ("Ford Falcon (EL)"), else to the kept
  // generation that title redirects into, else it stays a name of the kept nameplate.
  const bareName = n => norm(String(n.label).replace(/\s*\([^()]*\)\s*$/, ""));
  const genCode = (g, f) => norm(String(g.label).slice(String(f.label).length).replace(/[()]/g, " "));
  const tops = nodes.filter(f => live(f) && !f.familyOf && (f.generations || []).some(id => live(byId.get(id))));
  const own = (f, g) => g.wp && norm(article(g.wp)) !== norm(article(f.wp));
  const plateRows = [];
  for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) {
    const a = tops[i], b = tops[j];
    if (a.make !== b.make || bareName(a) !== bareName(b)) continue;
    const ga = a.generations.map(id => byId.get(id)).filter(live), gb = b.generations.map(id => byId.get(id)).filter(live);
    const ca = new Map(ga.map(g => [genCode(g, a), g])), cb = new Map(gb.map(g => [genCode(g, b), g]));
    const met = [...ca.keys()].filter(c => c && cb.has(c));
    if (met.length < 3 || met.length < 0.8 * Math.max(ga.length, gb.length)) continue;
    const [keep, dup] = ga.filter(g => own(a, g)).length >= gb.filter(g => own(b, g)).length ? [a, b] : [b, a];
    plateRows.push({ keep, dup, kc: keep === a ? ca : cb, dc: keep === a ? cb : ca });
  }
  const lostTitles = plateRows.flatMap(r => [...r.dc.entries()].filter(([c]) => !r.kc.has(c)).map(([, g]) => `${r.keep.make} ${r.keep.label} (${g.label.slice(r.dup.label.length).trim()})`));
  const look = lostTitles.filter(t => !(("look:" + t) in cache));
  for (let i = 0; i < look.length; i += 50) {
    const part = look.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1 });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const n0 = norms.get(t) || t, rd = reds.get(n0), to = rd ? rd.to : n0, p = pages.get(to);
      cache["look:" + t] = { to, missing: !p || !!p.missing }; });
    save();
  }
  const ownerOf = title => nodes.find(n => live(n) && n.wp && norm(article(n.wp)) === norm(title) && !n.familyOf) ||
    nodes.find(n => live(n) && n.wp && norm(article(n.wp)) === norm(title));
  plateRows.forEach(({ keep, dup, kc, dc }) => {
    const gens = {};
    dc.forEach((g, c) => {
      if (kc.has(c)) { gens[g.id] = kc.get(c).id; return; }
      const t = `${keep.make} ${keep.label} (${g.label.slice(dup.label.length).trim()})`, at = cache["look:" + t];
      const o = at && !at.missing ? ownerOf(at.to) : null;
      gens[g.id] = o && o.id !== dup.id && !dup.generations.includes(o.id) ? o.id : null;
    });
    out[dup.id] = { plate: true, into: keep.id, name: `${dup.make} ${dup.label}`, wp: article(dup.wp), gens };
    report.push(`plate    ${dup.id} (${dup.label}, ${dc.size} generations) -> ${keep.id} (${keep.label}): ` +
      Object.entries(gens).map(([g, t]) => `${(byId.get(g) || {}).label} -> ${t ? (byId.get(t) || {}).label : "a name"}`).join("; "));
  });
  // A car standing for a list of the cars of its name (its link is a set index or
  // disambiguation page) built in the very years of one car the list gives, of its
  // make: "Ford Fairlane" (1955-1970) beside the Fairlane (Americas), "Fiat Topolino"
  // beside the Fiat 500 "Topolino". It is that car twice. Each of its connections
  // goes to the listed car whose years the other end meets (within ten years), the
  // nearest, the twin where years cannot tell; one meeting none goes (the Topolino's Citroën Ami is the 2023 Topolino's,
  // a rebadged Ami with no article of its own).
  const LISTS = ["Template:Set index article", "Template:Disambiguation", "Template:Car disambiguation", "Template:Hndis"];
  const singles = nodes.filter(n => live(n) && n.type === "model" && !n.familyOf && n.wp && !/^name-/.test(n.id) &&
    !(n.generations || []).some(id => live(byId.get(id))) && Number.isFinite(n.year) && !out[n.id]);
  const askList = [...new Set(singles.map(n => article(n.wp)))].filter(t => !(("list:" + t) in cache));
  for (let i = 0; i < askList.length; i += 50) {
    const part = askList.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), prop: "templates|pageprops", tltemplates: LISTS.join("|"), tllimit: "max", ppprop: "disambiguation" });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const p = pages.get(norms.get(t) || t); cache["list:" + t] = !!(p && ((p.templates || []).length || (p.pageprops && "disambiguation" in p.pageprops))); });
    save();
  }
  const holders = singles.filter(n => cache["list:" + article(n.wp)]);
  const needLists = [...new Set(holders.map(n => article(n.wp)))].filter(t => !(("text:" + t) in cache));
  for (let i = 0; i < needLists.length; i += 20) {
    const part = needLists.slice(i, i + 20);
    const r = await query({ action: "query", titles: part.join("|"), prop: "revisions", rvprop: "content", rvslots: "main" });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const p = pages.get(norms.get(t) || t); cache["text:" + t] = p && p.revisions ? p.revisions[0].slots.main.content : ""; });
    save();
  }
  const listed = t => [...String(cache["text:" + t] || "").matchAll(/^\s*\*[^\n]*?\[\[([^\]|#]+)/gm)].map(m => m[1].trim());
  const entryTitles = [...new Set(holders.flatMap(n => listed(article(n.wp))))].filter(t => !(("look:" + t) in cache));
  for (let i = 0; i < entryTitles.length; i += 50) {
    const part = entryTitles.slice(i, i + 50);
    const r = await query({ action: "query", titles: part.join("|"), redirects: 1 });
    const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const reds = new Map((q.redirects || []).map(x => [x.from, x]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    part.forEach(t => { const n0 = norms.get(t) || t, rd = reds.get(n0), to = rd ? rd.to : n0, p = pages.get(to);
      cache["look:" + t] = { to, fragment: rd && rd.tofragment || null, missing: !p || !!p.missing }; });
    save();
  }
  const carsOf = new Map();
  nodes.forEach(n => { if (live(n) && !n.familyOf && (n.type === "model" || n.type === "family") && n.wp) {
    const k = norm(article(n.wp)); (carsOf.get(k) || carsOf.set(k, []).get(k)).push(n); } });
  const span = n => {
    if (n.type === "family") {
      const gs = (n.generations || []).map(id => byId.get(id)).filter(g => live(g) && Number.isFinite(g.year));
      if (gs.length) return [Math.min(...gs.map(g => g.year)), Math.max(...gs.map(g => Number.isFinite(g.end) ? g.end : 2026))];
    }
    const o = n.familyOf ? byId.get(n.familyOf) : null;
    return Number.isFinite(n.year) ? [n.year, Number.isFinite(n.end) ? n.end : n.year] : o ? span(o) : null;
  };
  const gap = (a, b) => Math.max(0, a[0] - b[1], b[0] - a[1]);
  holders.forEach(h => {
    const entries = listed(article(h.wp)).map(t => cache["look:" + t]).filter(at => at && !at.missing && !at.fragment);
    const carsAt = at => (carsOf.get(norm(at.to)) || []).filter(c => c.id !== h.id && c.make === h.make);
    const twin = entries.flatMap(carsAt).filter(c => c.year === h.year && c.end === h.end);
    if (twin.length !== 1) return;
    // The cars a connection may go to: the twin, and the listed cars of the name
    // itself ("Ford LTD (Australia)" lands in the Fairlane (Australia)'s article).
    const cars = [...new Set([twin[0], ...entries.filter(at => norm(at.to).includes(norm(h.label))).flatMap(carsAt)])];
    const route = {};
    (adj.get(h.id) || []).forEach(([t, o]) => {
      if (t === "made" || t === "name") return;
      const on = byId.get(o), so = on && span(on);
      if (!so) { route[o] = twin[0].id; return; }
      const fit = cars.map(c => ({ c, g: span(c) ? gap(so, span(c)) : Infinity })).filter(x => x.g <= 10)
        .sort((x, y) => x.g - y.g || (x.c === twin[0] ? -1 : y.c === twin[0] ? 1 : 0))[0];
      route[o] = fit ? fit.c.id : null;
    });
    out[h.id] = { into: twin[0].id, name: `${h.make} ${h.label}`, route };
    report.push(`twice    ${h.id} (${h.make} ${h.label} ${h.year}-${h.end}) -> ${twin[0].id} (${twin[0].label}): ` +
      Object.entries(route).filter(([, t]) => t !== twin[0].id).map(([o, t]) => `${(byId.get(o) || {}).label} -> ${t ? byId.get(t).label : "gone"}`).join("; "));
  });
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/duplicate_cars.js"),
    "// Generated by scripts/duplicate_cars.js. Do not edit: change the rule.\nwindow.DUPLICATE_CARS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  process.stdout.write(`${rows.length} single cars that are a generation shown twice, ${lines.length} folded\n`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
