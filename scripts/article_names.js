#!/usr/bin/env node
// Writes app/article_names.js: cars that carry a name their article does not give.
//   - a label that is only the article's bracket ("ABC · 1920 automobile", "Mini ·
//     (Mark I)"): the car takes the name its infobox gives ("12hp", "Mark I").
//   - a label that is a company's name on an article about one car ("Porter · Motor
//     Company"): the car's own name ("Steam Stanhope"), or the label without the
//     company suffix ("Mercury · Cyclecar").
//   - a make that is the first word of the car's maker ("Armstrong" for Armstrong
//     Siddeley): the car goes to the maker's whole name.
//   - another firm of the make's name: a make of its own, named with its year as the
//     article's title is ("Standard (1912 automobile)"), or the year of a car whose
//     article is named after its own maker and is older than the make (the 1913
//     Mercury Cyclecar under Ford's Mercury).
// Articles with no infobox (marque stubs) are left as they are, by the owner's ruling
// of 8 Nov 2026. Nothing here is written by hand.
//
//   node scripts/article_names.js CACHE.json      fetches articles into CACHE.json
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
    if (f === "article_names.js") { window.ARTICLE_NAMES = {}; continue; }
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function query(params) {
  for (let t = 0; ; t++) {
    try { return await post(new URLSearchParams(Object.assign({ format: "json", formatversion: 2, maxlag: 5 }, params)).toString()); }
    catch (e) { if (t > 3) throw e; await sleep(2000); }
  }
}
// Templates and redirect target of each title.
async function fetchKinds(titles, cache) {
  const todo = titles.filter(t => !(t in cache.kind));
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const r = await query({ action: "query", titles: batch.join("|"), redirects: 1, prop: "templates|pageprops", tllimit: "max", tlnamespace: 10, ppprop: "disambiguation" });
    const q = r.query || {};
    const hop = new Map();
    (q.normalized || []).forEach(x => hop.set(x.from, x.to));
    (q.redirects || []).forEach(x => hop.set(x.from, x.to + (x.tofragment ? "#" + x.tofragment : "")));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    for (const t of batch) {
      let to = t; for (let k = 0; k < 4 && hop.has(to.split("#")[0]); k++) to = hop.get(to.split("#")[0]);
      const p = pages.get(to.split("#")[0]);
      cache.kind[t] = p ? { target: to, missing: !!p.missing, dis: !!(p.pageprops && "disambiguation" in p.pageprops),
        tpl: (p.templates || []).map(x => x.title.replace(/^Template:/, "")).filter(x => /^Infobox|^Disambiguation/i.test(x)) } : { target: to, missing: true, dis: false, tpl: [] };
    }
    await sleep(500);
  }
}
async function fetchTexts(titles, cache) {
  const todo = [...new Set(titles)].filter(t => !(t in cache.text));
  for (let i = 0; i < todo.length; i += 20) {
    const batch = todo.slice(i, i + 20);
    const r = await query({ action: "query", titles: batch.join("|"), prop: "revisions", rvprop: "content", rvslots: "main" });
    const pages = new Map(((r.query || {}).pages || []).map(p => [p.title, p]));
    const hop = new Map(((r.query || {}).normalized || []).map(x => [x.from, x.to]));
    for (const t of batch) {
      const p = pages.get(hop.get(t) || t);
      cache.text[t] = p && p.revisions ? p.revisions[0].slots.main.content : null;
    }
    await sleep(500);
  }
}

const words = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const norm = s => words(s).join("");
const bare = t => String(t || "").split("#")[0].replace(/\s*\([^()]*\)\s*$/, "").trim();
const COMPANY_LABEL = /^(?:(?:Motor|Automobile|Auto|Car|Carriage|Cyclecar|Electric|Vehicle|Steam|Truck|Manufacturing|Engineering)\s+)*(?:Company|Corporation|Co\.?|Inc\.?|Limited|Ltd\.?|Motors|Works|Cars|Autocars|Engineering)$/i;
const COMPANY_TPL = /^Infobox (?:company|brand|automobile manufacturer|manufacturer|motorcycle manufacturer|organization)$/i;
const CAR_TPL = /^Infobox (?:automobile|racing car|dragster|concept car|vehicle|truck|tractor|bus|motorcycle)$/i;
// Plain text of a stretch of wikitext.
function dropFiles(s) {
  let out = "", i = 0;
  const src = String(s || "");
  for (;;) {
    const m = /\[\[\s*(?:File|Image)\s*:/i.exec(src.slice(i));
    if (!m) { out += src.slice(i); break; }
    const at = i + m.index; out += src.slice(i, at);
    let depth = 0, j = at;
    for (; j < src.length; j++) {
      if (src.startsWith("[[", j)) { depth++; j++; } else if (src.startsWith("]]", j)) { depth--; j++; if (!depth) { j++; break; } }
    }
    i = j;
  }
  return out;
}
// Text with every template taken out, nested ones included.
function dropTemplates(s) {
  const src = String(s || "");
  let out = "", depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith("{{", i)) { depth++; i++; continue; }
    if (depth && src.startsWith("}}", i)) { depth--; i++; continue; }
    if (!depth) out += src[i];
  }
  return out;
}
// The lead's first paragraph that names its subject in bold.
function firstParagraph(t) {
  const lead = dropFiles(dropTemplates(String(t || "").replace(/<!--[\s\S]*?-->/g, "")))
    .replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  const h = lead.search(/\n==[^=]/), body = h >= 0 ? lead.slice(0, h) : lead;
  const paras = body.split(/\n+/).map(x => x.trim()).filter(x => x && !/^[{|!}]/.test(x) && !/^\[\[Category:/i.test(x));
  return paras.find(x => x.includes("'''")) || paras.find(x => /\s(?:is|was|were|are)\s/.test(x)) || "";
}
function plain(s) {
  let v = dropFiles(String(s || "")).replace(/<!--[\s\S]*?-->/g, "").replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  for (let g = 0; g < 30 && /\{\{[^{}]*\}\}/.test(v); g++) v = v.replace(/\{\{([^{}]*)\}\}/g, (a, b) => {
    const parts = b.split("|").map(x => x.trim()), name = (parts.shift() || "").toLowerCase();
    const args = parts.filter(x => !/^[a-z_ ]+=/i.test(x));
    if (/^(?:nowrap|nobr|lang|transl|small|nobold|ill|interlanguage link|flagicon|flag|flagcountry|lang-[a-z]+)$/.test(name)) return name.startsWith("flag") ? (args[0] || "") : name === "ill" || name === "interlanguage link" ? (args[0] || "") : (args[args.length - 1] || "");
    if (/^(?:plain ?list|ubl|unbulleted list|hlist|flatlist)$/.test(name)) return args.join(", ");
    if (/^(?:start date|start date and age|end date|birth date|death date|date)$/.test(name)) return args.filter(x => /^\d{3,4}$/.test(x))[0] || "";
    return "";
  });
  return v.replace(/\[\[(?:[^\[\]|]*\|)?([^\[\]]*)\]\]/g, "$1").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/'{2,}/g, "").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();
}
(async () => {
  const cachePath = process.argv[2];
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  cache.kind = cache.kind || {}; cache.text = cache.text || {};
  const { LF, nodes, links } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const live = n => n && !n.retired;
  const cars = nodes.filter(n => live(n) && (n.type === "model" || n.type === "family") && !n.familyOf && !/^llm-/.test(n.id) && n.wp);
  const makes = nodes.filter(n => live(n) && n.type === "make");
  await fetchKinds([...new Set(cars.map(c => c.wp.split("#")[0]).concat(makes.filter(m => m.wp).map(m => m.wp.split("#")[0])))], cache);
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const kindOf = t => {
    const k = cache.kind[String(t || "").split("#")[0]];
    if (!k) return "none";
    if (k.missing) return "missing";
    if (k.dis) return "disamb";
    const c = k.tpl.some(x => COMPANY_TPL.test(x)), a = k.tpl.some(x => CAR_TPL.test(x));
    return c && a ? "both" : c ? "company" : a ? "car" : "noinfobox";
  };
  const makeOf = new Map(makes.map(m => [norm(m.label), m]));
  const need = [];
  for (const c of cars) {
    const k = kindOf(c.wp), mk = makeOf.get(norm(c.make));
    if (k !== "car" || !mk || mk.country == null || mk.country === "Unknown" || /\(/.test(c.wp) || COMPANY_LABEL.test(c.label)) need.push(cache.kind[c.wp.split("#")[0]].target.split("#")[0]);
  }
  await fetchTexts(need, cache);
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const idOf = x => typeof x === "object" && x ? x.id : x;
  const carsUnder = new Map();
  cars.forEach(c => { const k = norm(c.make); if (!carsUnder.has(k)) carsUnder.set(k, []); carsUnder.get(k).push(c); });
  const textOf = t => { const k = cache.kind[String(t || "").split("#")[0]]; return k ? cache.text[k.target.split("#")[0]] || null : null; };
  const carBox = t => (String(t || "").match(/\{\{\s*Infobox (?:automobile|racing car|dragster|concept car|vehicle)[\s\S]*?\n\}\}/i) || [""])[0];
  const field = (box, nm) => { const m = new RegExp("\\n\\s*\\|\\s*" + nm + "\\s*=([^\\n]*)", "i").exec(box); return m ? plain(m[1]).split(/\n/)[0].trim() : ""; };
  const GENERIC = new Set("automobile automobiles auto motor motors car cars company co corporation corp incorporated inc limited ltd vehicle vehicles carriage electric steam gasoline manufacturing manufacturer marque works truck construction of america american us engineering cyclecar microcar supercar dragster revival".split(" "));
  const generic = s => !words(s).length || words(s).every(w => GENERIC.has(w) || /^1[89]\d\d$|^20\d\d$/.test(w));
  const SUFFIX = /(?:\s+(?:(?:Motor|Automobile|Auto|Car|Carriage|Cyclecar|Electric|Vehicle|Steam|Truck|Manufacturing|Engineering)\s+)*(?:Company|Corporation|Co\.?|Inc\.?|Limited|Ltd\.?|Motors|Works|Cars|Autocars)(?:\s+of\s+America)?\.?)+$/i;
  const CORP = /\s*\b(?:Company|Corporation|Co\.?|Inc\.?|Limited|Ltd\.?)$/i;
  const firmName = s => bare(s).replace(SUFFIX, "").trim();
  // The words of `name` after the leading words of `lead`, or null when it does not start with them.
  const after = (name, lead) => {
    const nw = String(name || "").split(/\s+/), lw = words(lead);
    let k = 0, got = [];
    for (; k < nw.length && got.length < lw.join("").length; k++) { got = got.concat(words(nw[k])); if (got.join("") === lw.join("")) { k++; break; } }
    return got.join("") === lw.join("") ? nw.slice(k).join(" ").trim() : null;
  };
  const bracketOf = t => (/\(([^()]*)\)\s*$/.exec(String(t || "").split("#")[0]) || [])[1] || null;
  const out = {}, report = [], moves = [];
  for (const c of cars) {
    const kind = kindOf(c.wp);
    if (kind !== "car" && kind !== "both") continue;
    const t = textOf(c.wp); if (!t) continue;
    const box = carBox(t);
    const name = field(box, "name").split(/\s*[,/]\s*|\s+or\s+/)[0].trim();
    const manu = field(box, "manufacturer").split(/\s*[,;]\s*|\s+and\s+/)[0].replace(/\s*\([^)]*\)\s*$/, "").trim();
    const br = bracketOf(c.wp), tag = `${c.id}  ${c.make} · ${c.label}  [${c.wp}]`;
    const rest = name ? after(name, c.make) : null;
    const row = { id: c.id };
    // 1. The label is only the title's bracket.
    if (br && (norm(c.label) === norm(br)) && rest && !generic(rest)) { row.label = rest; report.push(`name     ${tag} -> ${rest}  (infobox "${name}")`); }
    // 2. A company's name on an article about one car.
    else if (COMPANY_LABEL.test(c.label)) {
      const cut = c.label.replace(CORP, "").trim();
      const own = name && after(name, c.make) === null && !generic(name) ? name : null;
      if (rest && !generic(rest) && !/ and /.test(rest)) { row.label = rest; report.push(`name     ${tag} -> ${rest}  (infobox "${name}")`); }
      else if (cut && cut !== c.label && norm(c.make + " " + cut) === norm(name)) { row.label = cut; report.push(`name     ${tag} -> ${cut}  (infobox "${name}")`); }
      else if (own) { row.label = own; report.push(`name     ${tag} -> ${own}  (infobox "${name}")`); }
      else report.push(`keep     ${tag}  (infobox "${name}")`);
    }
    // 3. The make is the first word of the maker's name.
    const F = firmName(manu);
    if (F && words(F).length > words(c.make).length && after(F, c.make) && after(bare(c.wp), F)) {
      const label = after(row.label || c.label, after(F, c.make));
      if (label && !generic(label)) moves.push({ c, to: F, label, tag });
    }
    // 4. Another firm of the make's name.
    const mk = makeOf.get(norm(c.make));
    const others = (carsUnder.get(norm(c.make)) || []).filter(x => x.id !== c.id);
    const yr = br && /^(1[89]\d\d|20[0-2]\d) (?:automobile|car)$/.exec(br);
    const ownMaker = norm(firmName(c.wp)) && manu && norm(bare(c.wp)) === norm(manu);
    let mint = null;
    if (yr && norm(bare(c.wp)) === norm(c.make) && others.some(x => bracketOf(x.wp) !== br)) mint = `${c.make} (${yr[1]})`;
    else if (ownMaker && mk && mk.year && c.year && c.year < mk.year - 5 && others.length) mint = `${c.make} (${c.year})`;
    if (mint) { row.mint = { id: "mk-" + words(mint).join("-"), label: mint, year: +(yr ? yr[1] : c.year) || null, country: null }; report.push(`own make ${tag} -> ${mint}  (maker "${manu}")`); }
    if (row.label || row.mint) out[c.id] = row;
  }
  // A make whose every car moves takes the maker's name; otherwise the cars go to it.
  const byTo = new Map();
  moves.forEach(m => { const k = norm(m.c.make) + ">" + norm(m.to); if (!byTo.has(k)) byTo.set(k, []); byTo.get(k).push(m); });
  for (const [, group] of byTo) {
    const from = makeOf.get(norm(group[0].c.make)), there = makeOf.get(norm(group[0].to));
    const all = (carsUnder.get(norm(group[0].c.make)) || []).every(x => group.some(m => m.c.id === x.id));
    group.forEach(m => {
      const row = out[m.c.id] || (out[m.c.id] = { id: m.c.id });
      row.label = m.label;
      if (there) row.make = there.id;
      else if (all && from) row.renameMake = { id: from.id, label: m.to };
      else row.mint = { id: "mk-" + words(m.to).join("-"), label: m.to, year: null, country: from && from.country !== "Unknown" ? from.country : null };
      report.push(`maker    ${m.tag} -> ${m.to} · ${m.label}` + (there ? "" : all ? `  (make ${from.label} renamed)` : "  (new make)"));
    });
  }
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/article_names.js"),
    "// Generated by scripts/article_names.js. Do not edit: change the rule.\nwindow.ARTICLE_NAMES = {\n" + lines.join("\n") + "\n};\n");
  console.log(lines.length, "rows");
  process.exit(0);
})();
