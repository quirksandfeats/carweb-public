#!/usr/bin/env node
// Writes app/company_articles.js: "cars" whose article is not about one car.
//   - a company or brand article shown as a car ("Knox · Automobile Company"): the
//     article belongs to the make. The make takes the article, its founding year and
//     its country, and the car goes. Where the make in the graph is a different firm
//     of the same name (the Indian Premier holding the Indianapolis one), the firm
//     becomes a make of its own.
//   - a make split at the first space ("St." + "Louis Motor Company", "De" +
//     "Dion-Bouton"): the car goes to the make its article names.
//   - a car whose label is only the article's bracket ("ABC · 1920 automobile") or a
//     company name: it takes the article's own name for the car ("12hp").
// Marque stubs with no infobox ("The Ace was a British car built 1912-1916") are left
// as they are. So are the brand nameplates the LLM made (Acadian, Meteor, HSV).
// Nothing here is written by hand.
//
//   node scripts/company_articles.js CACHE.json      fetches articles into CACHE.json
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
    if (f === "company_articles.js") { window.COMPANY_ARTICLES = {}; continue; }
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
    if (k !== "car" || !mk || mk.country == null || mk.country === "Unknown" || /\(/.test(c.wp)) need.push(cache.kind[c.wp.split("#")[0]].target.split("#")[0]);
  }
  await fetchTexts(need, cache);
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const idOf = x => typeof x === "object" && x ? x.id : x;
  const linksOf = new Map();
  links.forEach(l => { if (l.retired) return; [idOf(l.source), idOf(l.target)].forEach(x => { if (!linksOf.has(x)) linksOf.set(x, []); linksOf.get(x).push(l); }); });
  const carsUnder = new Map();
  cars.forEach(c => { const k = norm(c.make); if (!carsUnder.has(k)) carsUnder.set(k, []); carsUnder.get(k).push(c); });
  const textOf = t => { const k = cache.kind[String(t || "").split("#")[0]]; return k ? cache.text[k.target.split("#")[0]] || null : null; };
  const companyBox = t => (String(t || "").match(/\{\{\s*Infobox (?:company|brand|automobile manufacturer|manufacturer|organization)[\s\S]*?\n\}\}/i) || [""])[0];
  const field = (box, names) => { for (const nm of names) { const m = new RegExp("\\n\\s*\\|\\s*" + nm + "\\s*=([^\\n]*)", "i").exec(box); if (m && plain(m[1]).trim()) return plain(m[1]).trim(); } return ""; };
  const COUNTRIES = [...new Set(makes.map(m => m.country).filter(c => c && c !== "Unknown"))];
  const STATES = /\b(?:Alabama|Arizona|California|Colorado|Connecticut|Delaware|Florida|Georgia|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Missouri|Nebraska|New Hampshire|New Jersey|New York|North Carolina|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|Tennessee|Texas|Vermont|Virginia|Washington|Wisconsin|U\.S\.|USA|United States)\b/;
  const DEMONYM = { American: "United States", British: "United Kingdom", English: "United Kingdom", Scottish: "United Kingdom", French: "France", German: "Germany", Italian: "Italy", Italians: "Italy", Danish: "Denmark", Dutch: "Netherlands", Swedish: "Sweden", Belgian: "Belgium", Swiss: "Switzerland", Austrian: "Austria", Spanish: "Spain", Australian: "Australia", Canadian: "Canada", Japanese: "Japan", Russian: "Russia", Ukrainian: "Ukraine", Czech: "Czech Republic", Hungarian: "Hungary", Polish: "Poland" };
  const countryIn = s => {
    s = String(s || "");
    const hit = COUNTRIES.concat(["Belgium", "Hungary", "Denmark"]).find(c => new RegExp("\\b" + c + "\\b").test(s));
    if (hit) return hit;
    if (STATES.test(s)) return "United States";
    if (/\b(?:England|Scotland|Wales|UK)\b/.test(s)) return "United Kingdom";
    return null;
  };
  // What the article says about its firm: its name, founding year, country, and
  // whether its first sentence calls the subject a firm or a car.
  const FIRM_NOUN = /^(?:group|company|companies|corporation|manufacturer|manufacturers|maker|makers|brand|marque|marques|producer|importer|firm|division|subsidiary|line|enterprise|business|coachbuilder)$/i;
  const CAR_NOUN = /^(?:car|cars|automobile|automobiles|vehicle|vehicles|cyclecar|cyclecars|steamer|runabout|roadster|buggy|highwheeler|wheeler|utv|atv|van|truck|suv|coupe|sedan|tricar|voiturette|microcar)$/i;
  const STOP = /^(?:built|made|manufactured|produced|that|which|who|by|in|from|based|founded|of|located|headquartered|sold|marketed|designed|developed|created|established|operating|operated|started|for|and|with|whose|named|run|owned|known|between|at|until|during|since|used|launched|assembled)$/i;
  function firmOf(c) {
    const t = textOf(c.wp) || "", box = companyBox(t);
    const lead = plain(firstParagraph(t)).replace(/\s+/g, " ");
    const at = lead.search(/\s(?:is|was|were|are)\s/);
    const sentence = at < 0 ? "" : lead.slice(Math.max(0, lead.lastIndexOf(". ", at) + 1), at + 260).trim();
    const subject = at < 0 ? "" : lead.slice(Math.max(0, lead.lastIndexOf(". ", at) + 1), at).trim();
    let what = null;
    if (at >= 0) {
      if (/\b(?:Company|Corporation|Works|Motors|Limited|Ltd|Inc|Co)\b\.?/.test(subject.replace(/\([^)]*\)/g, ""))) what = "firm";
      else {
        const np = [];
        for (const w of lead.slice(at).replace(/^\s*\w+\s+/, "").replace(/^(?:one of the|one of|part of the|part of|the name of an?|the name of)\s+/i, "").split(/[\s,;:()]+/).filter(Boolean)) { if (STOP.test(w) || (/^[a-z]+ing$/.test(w) && np.some(x => FIRM_NOUN.test(x) || CAR_NOUN.test(x))) || np.length > 9) break; np.push(w.replace(/[^\w-]/g, "")); }
        for (let k = np.length - 1; k >= 0 && !what; k--) what = FIRM_NOUN.test(np[k]) ? "firm" : CAR_NOUN.test(np[k].replace(/-/g, "")) ? "car" : null;
      }
    }
    // "The Premier Motor Manufacturing Company built ...": a firm named as the subject.
    if (!what && /^(?:The\s+)?(?:[A-Z][\w&.'-]*\s+){0,5}(?:Company|Corporation|Works|Motors|Limited)\b/.test(lead)) what = "firm";
    const dem = (sentence.match(new RegExp("\\b(" + Object.keys(DEMONYM).join("|") + ")\\b")) || [])[1];
    const title = cache.kind[c.wp.split("#")[0]].target.split("#")[0];
    const year = +((/\((1[89]\d\d|20[0-2]\d)\b[^)]*\)\s*$/.exec(title) || [])[1]) || null;
    const span = /\b(?:from|between)\s+(1[89]\d\d|20[0-2]\d)\s+(?:to|until|till|through|and)\s+(1[89]\d\d|20[0-2]\d)\b/.exec(lead) || [];
    // "Standard Motor Construction Company (1904–1905) was ...": the subject's own years
    // before any infobox, which can be a predecessor's.
    const own = /^[^.]*?\((1[89]\d\d|20[0-2]\d)\s*[–-]\s*(1[89]\d\d|20[0-2]\d)\)/.exec(lead) || [];
    const founded = +own[1] || +((field(box, ["founded", "foundation", "launched", "introduced"]).match(/\b(1[89]\d\d|20[0-2]\d)\b/) || [])[1]) || +span[1] || null;
    const defunct = +own[2] || +((field(box, ["defunct", "discontinued", "dissolved"]).match(/\b(1[89]\d\d|20[0-2]\d)\b/) || [])[1]) || +span[2] || null;
    const country = countryIn(field(box, ["hq_location_country", "location_country", "country", "hq_location", "hq_location_city", "location", "location_city"])) || (dem && DEMONYM[dem]) || countryIn(sentence) || null;
    const known = (/commonly known as ([A-Z][\w\-. ]+?)(?=[\s,(]|$)/.exec(lead) || [])[1] || null;
    return { title, year, founded, defunct, country, what, known, sentence: sentence.slice(0, 200) };
  }
  // Labels that name no car: a company's suffix, a bracket, a year.
  const GENERIC = new Set("automobile automobiles auto motor motors car cars company co corporation corp incorporated inc limited ltd vehicle vehicles carriage electric steam gasoline manufacturing manufacturer marque works truck construction of america american us engineering cyclecar".split(" "));
  const genericLabel = c => norm(c.label) === norm(c.make) || words(c.label).every(w => GENERIC.has(w) || /^1[89]\d\d$/.test(w));
  const SUFFIX = /\s+(?:(?:Motor|Automobile|Auto|Car|Carriage|Electric|Vehicle|Steam|Truck|Manufacturing|Engineering|Spring Buggy)\s+)*(?:Company|Corporation|Co\.?|Inc\.?|Limited|Ltd\.?|Motors|Works)(?:\s+of\s+America)?$/i;
  const firmName = title => bare(title).replace(SUFFIX, "").trim();
  const out = {}, report = [], rows = [];
  for (const c of cars) {
    const k = cache.kind[c.wp.split("#")[0]];
    if (kindOf(c.wp) !== "company") continue;
    const tag = `${c.id}  ${c.make} · ${c.label}  [${c.wp}]`;
    if (norm(k.target.split("#")[0]) !== norm(c.wp.split("#")[0])) { report.push(`skip     ${tag}: the title redirects to the firm (${k.target})`); continue; }
    if (c.type === "family" && (c.generations || []).some(id => live(byId.get(id)))) { report.push(`skip     ${tag}: a nameplate with generations`); continue; }
    const f = firmOf(c);
    if (f.what !== "firm") { report.push(`skip     ${tag}: the article calls it a ${f.what || "?"} | ${f.sentence}`); continue; }
    const generic = genericLabel(c);
    // "St." + "Louis Motor Company": the firm's name is the whole title.
    const whole = !generic && norm(bare(c.wp)) === norm(c.make + " " + c.label);
    if (!generic && !whole) { report.push(`skip     ${tag}: a car's name ("${c.label}")`); continue; }
    let name = generic ? c.make : firmName(c.make + " " + c.label);
    if (whole && f.known && makeOf.has(norm(f.known))) name = f.known;
    rows.push({ c, f, name, whole, tag });
  }
  // Same-name firms: one make each. A make that already stands for a firm (its
  // country, its own company article, cars of its own) keeps its name; the other
  // takes its year, as Wikipedia's title does ("Standard (1904)").
  const byName = new Map();
  rows.forEach(r => { const k = norm(r.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); });
  for (const [k, group] of byName) {
    const mk = makeOf.get(k) || null;
    const others = mk ? (carsUnder.get(k) || []).filter(x => !rows.some(r => r.c.id === x.id)) : [];
    // A make whose own article is another firm's, or whose country is another,
    // or whose other cars were built outside this firm's years, is another firm.
    const own = mk && others.length && kindOf(mk.wp) === "company" && norm(cache.kind[mk.wp.split("#")[0]].target) !== norm(group[0].f.title);
    const foreign = r => mk && others.length && mk.country && mk.country !== "Unknown" && r.f.country && r.f.country !== mk.country;
    const outside = r => others.some(x => x.year && ((r.f.defunct && x.year > r.f.defunct + 2) || (r.f.founded && x.year < r.f.founded - 10)));
    const apart = r => !!(own || foreign(r) || outside(r));
    group.sort((a, b) => (a.f.year || a.f.founded || a.c.year || 9999) - (b.f.year || b.f.founded || b.c.year || 9999));
    const clash = group.length > 1 || group.some(apart);
    group.forEach((r, i) => {
      const when = r.f.year || r.f.founded || r.c.year;
      const row = { id: r.c.id, wp: r.f.title, founded: r.f.founded || r.c.year || null, country: r.f.country || null };
      // "St." holding only "Louis Motor Company": the make is the firm, under its name.
      const lone = r.whole && !mk && (carsUnder.get(norm(r.c.make)) || []).length === 1 ? makeOf.get(norm(r.c.make)) : null;
      if (mk && !apart(r) && !clash) Object.assign(row, { make: mk.id });
      // Same-name firms where the make is none of them in particular: each by its year.
      else if (mk && !apart(r) && i === 0 && !others.length) Object.assign(row, { make: mk.id, label: `${r.name} (${when})` });
      else if (lone) Object.assign(row, { make: lone.id, label: r.name });
      else Object.assign(row, { mint: { id: "mk-" + words(r.name + " " + (clash ? when : "")).join("-"), label: clash ? `${r.name} (${when})` : r.name } });
      out[r.c.id] = row;
      const was = row.make && byId.get(row.make);
      const to = row.mint ? `new make ${row.mint.label}` : row.label ? `make ${was.label} renamed ${row.label}` : `make ${was.label}`;
      report.push(`fold     ${r.tag} -> ${to}  ${row.founded || "?"}-${r.f.defunct || ""} ${row.country || "?"}  links:${(linksOf.get(r.c.id) || []).filter(l => l.type !== "made").map(l => l.type).join(",") || "-"}` +
        (others.length ? `  [${others.length} other cars: ${others.slice(0, 4).map(x => x.label + " " + x.year).join(", ")}]` : ""));
    });
  }
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/company_articles.js"),
    "// Generated by scripts/company_articles.js. Do not edit: change the rule.\nwindow.COMPANY_ARTICLES = {\n" + lines.join("\n") + "\n};\n");
  console.log(lines.length, "rows");
  process.exit(0);
})();
