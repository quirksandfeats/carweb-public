#!/usr/bin/env node
// Writes app/shared_names.js: separate cars that carry one name, read from
// Wikipedia's index of that name. Two kinds of index:
//   - the car's own page lists other articles (isListOfArticles), as "Chevrolet
//     Blazer" lists the K5 Blazer, the S-10 Blazer and the crossover;
//   - "<its title> (disambiguation)" lists them, as "Ford Capri (disambiguation)"
//     lists the Capri (Australia), the Capri EV and the Lincoln Capri.
// A listed line counts when its text carries the name and its page is a car of
// the graph and its own title (or the section it points at) carries the name.
// Lines under "See also" do not count. An index of the first kind is only a name
// when every titled page it lists is a car of the graph; then that car shows as
// the name, and an old read of its page hands each listed car its own mentions
// (applySharedPlatformForSingleGen in app/llm_families.js). Nothing here is
// written by hand.
//
//   node scripts/shared_names.js CACHE.json          fetches pages into CACHE.json
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
    if (f === "shared_names.js") { window.SHARED_NAMES = {}; continue; }
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
  for (let attempt = 0; ; attempt++) {
    try { return await post(new URLSearchParams(Object.assign({ format: "json", formatversion: 2, maxlag: 5 }, params)).toString()); }
    catch (e) { if (attempt > 3) throw e; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
  }
}
// Titles in batches of 50: where each lands (redirects, with the section), and
// whether the page is an index.
async function lookUp(titles, cache) {
  const need = [...new Set(titles)].filter(t => !(("look:" + t) in cache));
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    let cont = {}, pages = [], redirects = [], normalized = [];
    do {
      const r = await query(Object.assign({ action: "query", titles: batch.join("|"), redirects: 1, prop: "pageprops|templates",
        ppprop: "disambiguation", tltemplates: "Template:Set index article", tllimit: "max" }, cont));
      const q = r.query || {};
      pages = pages.concat(q.pages || []); redirects = redirects.concat(q.redirects || []); normalized = normalized.concat(q.normalized || []);
      cont = r.continue || null;
    } while (cont);
    const norm = new Map(normalized.map(x => [x.from, x.to])), red = new Map(redirects.map(x => [x.from, x]));
    const info = new Map();
    pages.forEach(p => {
      const o = info.get(p.title) || { missing: !!p.missing, index: false };
      if (p.pageprops && "disambiguation" in p.pageprops) o.index = true;
      if ((p.templates || []).length) o.index = true;
      info.set(p.title, o);
    });
    batch.forEach(t => {
      const n = norm.get(t) || t, r = red.get(n);
      const to = r ? r.to : n, o = info.get(to) || { missing: true, index: false };
      cache["look:" + t] = { to, fragment: r && r.tofragment || null, missing: o.missing, index: o.index };
    });
    process.stderr.write(`looked up ${Math.min(i + 50, need.length)}/${need.length}\r`);
  }
  return t => cache["look:" + t];
}
async function wikitexts(titles, cache) {
  const need = [...new Set(titles)].filter(t => !(("text:" + t) in cache));
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    const r = await query({ action: "query", titles: batch.join("|"), prop: "revisions", rvprop: "content", rvslots: "main" });
    const got = new Map(((r.query || {}).pages || []).map(p => [p.title, p.revisions ? p.revisions[0].slots.main.content : ""]));
    const norm = new Map(((r.query || {}).normalized || []).map(x => [x.from, x.to]));
    batch.forEach(t => { cache["text:" + t] = got.get(norm.get(t) || t) || ""; });
    process.stderr.write(`read ${Math.min(i + 40, need.length)}/${need.length}\r`);
  }
  return t => cache["text:" + t] || "";
}

const plain = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const carries = (text, core) => !!core && (" " + plain(text) + " ").includes(" " + core + " ");
// The lines of an index above "See also": [[page|text]] on a bullet, or the
// {{main}} pointer of a gallery caption.
function entriesOf(wikitext) {
  const out = [];
  for (const line of String(wikitext || "").split("\n")) {
    if (/^==+\s*(?:see also|references|notes|external links|further reading)\b/i.test(line)) break;
    const main = line.match(/\{\{\s*main\s*\|\s*([^}|]+)(?:\|[^}]*?l1\s*=\s*([^}|]+))?/i);
    if (main) { out.push({ page: main[1].trim(), text: (main[2] || main[1]).trim(), line }); continue; }
    if (!/^\*/.test(line)) continue;
    const m = line.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (!m || /^(?:file|image|category|wikt|wiktionary):/i.test(m[1])) continue;
    out.push({ page: m[1].trim(), text: (m[2] || m[1]).trim(), line });
  }
  return out;
}

(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/shared_names.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
  const { LF, nodes, links } = bootApp();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const isCar = n => n && (n.type === "model" || n.type === "family") && !n.familyOf && n.wp;
  const cars = nodes.filter(n => isCar(n) && !n.retired);
  const bare = t => String(t).split("#")[0].trim();
  // A car the nameplate's own list folded away comes back by the rule; it is listed
  // under its own id.
  const foldedInto = new Map();
  nodes.forEach(n => {
    if (!isCar(n) || !n.retired || !n.supersededBy) return;
    const g = byId.get(n.supersededBy);
    if (g && g.familyOf) foldedInto.set(n.id, g.familyOf);
  });
  const candidates = nodes.filter(n => isCar(n) && (!n.retired || foldedInto.has(n.id)));
  const own = await lookUp(candidates.map(n => bare(n.wp)), cache); save();
  const dab = await lookUp(cars.map(n => bare(n.wp) + " (disambiguation)"), cache); save();

  // Each car's article, as it lands.
  const byArticle = new Map();
  candidates.forEach(n => {
    const at = own(bare(n.wp)); if (!at || at.missing) return;
    (byArticle.get(at.to) || byArticle.set(at.to, []).get(at.to)).push(n);
  });
  const fullName = n => plain((n.make || "") + " " + n.label);
  const carOf = (title, holder) => {
    const here = (byArticle.get(title) || []).filter(n => n.id !== holder.id && !(n.retired && foldedInto.get(n.id) !== holder.id));
    if (!here.length) return null;
    const score = n => (fullName(n) === plain(title.replace(/\s*\([^()]*\)\s*$/, "")) || fullName(n) === plain(title) ? 4 : 0) +
      (bare(n.wp) === title ? 2 : 0) + (n.type === "family" ? 1 : 0) + (/^llm-related-/.test(n.id) ? 0 : 1);
    return here.slice().sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1))[0];
  };

  // The index for each car: its own page, or its disambiguation page.
  const holders = [];
  cars.forEach(n => {
    const at = own(bare(n.wp));
    if (at && !at.missing && at.index) holders.push({ n, page: at.to, index: true });
    else {
      const d = dab(bare(n.wp) + " (disambiguation)");
      if (d && !d.missing && d.index && (!at || d.to !== at.to)) holders.push({ n, page: d.to, index: false });
    }
  });
  const text = await wikitexts(holders.map(h => h.page), cache); save();
  // A page that only lists articles by the first rule is the car's own index; one
  // with sections of its own is an article about one car, whatever it is tagged.
  const kept = holders.filter(h => !h.index || LF.isListOfArticles(text(h.page)) || /\{\{\s*(?:set index|sia\b)/i.test(text(h.page)) && !/\{\{\s*infobox/i.test(text(h.page)));
  const entries = new Map(kept.map(h => [h, entriesOf(text(h.page))]));
  const targets = await lookUp([...entries.values()].flat().map(e => e.page), cache); save();
  // A listed section has to be in its article still: the Suzuki Carry's "Changhe
  // Suzuki Landy" is gone.
  const sectionOf = e => { const at = targets(e.page); return at && !at.missing ? (at.fragment || (e.page.includes("#") ? e.page.split("#")[1] : null)) : null; };
  const stext = await wikitexts([...entries.values()].flat().filter(sectionOf).map(e => targets(e.page).to), cache); save();
  const hasSection = (page, section) => {
    const s = plain(section);
    return !!s && stext(page).split("\n").some(line =>
      (/^=+[^=].*=+\s*$/.test(line.trim()) && plain(line.replace(/<[^>]*>/g, " ")).includes(s)) ||
      [...line.matchAll(/(?:\{\{\s*anchor\s*\|([^}]*)\}\}|\bid\s*=\s*"([^"]*)")/gi)].some(m => String(m[1] || m[2]).split("|").some(a => plain(a) === s)));
  };
  // The holder's own generations, by the article each was read from: a listed page
  // that is one of them is the holder again ("Aston Martin V8 Vantage (2005)").
  const genOf = h => (h.n.generations || []).map(id => byId.get(id)).filter(g => g && !g.retired && g.wp);
  const genLook = await lookUp(kept.flatMap(h => genOf(h).map(g => bare(g.wp))), cache); save();
  // What the holder's own article sets outside itself in its hatnote: "the EV, see
  // Ford Capri EV". Such a page is another car even where a read made it a generation.
  const HAT_RE = /\{\{\s*(?:about|for|for-multi|other uses|otheruses|distinguish|redirect[a-z-]*|hatnote|further)\b[^{}]*\}\}/gi;
  const hatnoteTitles = w => (String(w).split(/\n==/)[0].match(HAT_RE) || [])
    .flatMap(t => t.replace(/^\{\{|\}\}$/g, "").split("|").slice(1)).map(x => x.replace(/\[\[|\]\]/g, "").split("#")[0].trim()).filter(Boolean);
  const homeText = await wikitexts(kept.filter(h => !h.index).map(h => own(bare(h.n.wp))).filter(a => a && !a.missing).map(a => a.to), cache); save();
  const homeHat = await lookUp(kept.filter(h => !h.index).flatMap(h => { const a = own(bare(h.n.wp)); return a && !a.missing ? hatnoteTitles(homeText(a.to)) : []; }), cache); save();

  const out = {}, twice = [];
  // Names given by a number or by three letters or fewer ("1300", "GT") recur by
  // chance and by licence: only the holder's own make counts.
  const shortName = core => core.length <= 3 || /^\d+$/.test(core.replace(/ /g, ""));
  kept.forEach(h => {
    // The name is the page's: "Ford Capri", "Chevrolet Blazer". The car holding it
    // is called by it, not "Frontera Sport" on the Opel Frontera's page; a marque's
    // own name says nothing here (the make does).
    const name = plain(h.page.replace(/\s*\(disambiguation\)\s*$/i, ""));
    const make = plain(h.n.make), label = plain(String(h.n.label).replace(/\s*\([^()]*\)\s*$/, ""));
    if (!make || label === make || name !== make + " " + label) return;
    const core = label;
    const home = own(bare(h.n.wp));
    const apart = new Set(!h.index && home && !home.missing ? hatnoteTitles(homeText(home.to)).map(homeHat).filter(a => a && !a.missing).map(a => a.to) : []);
    const genArticles = new Set(genOf(h).map(g => genLook(bare(g.wp))).filter(a => a && !a.missing && (!home || a.to !== home.to) && !apart.has(a.to)).map(a => a.to));
    // A listed car carries the name in its own title, or in the section the line
    // points at ("Ford Consul Classic#Consul Capri"). One sold under the name in
    // some market is the car of another name: the Plymouth Cricket page lists the
    // Hillman Avenger, and the Avenger is no Cricket. A short name has to lead.
    const titled = t => {
      const rest = plain(String(t).replace(/\s*\([^()]*\)\s*$/, "")).split(" ");
      if (core.length > 3) return carries(rest.join(" "), core);
      const at = rest.indexOf(core.split(" ")[0]);
      return carries(rest.join(" "), core) && at >= 0 && at <= 1;
    };
    const seen = new Set(), list = [];
    let free = 0;
    entries.get(h).forEach(e => {
      const at = targets(e.page);
      if (!at || at.missing) return;
      const section = sectionOf(e);
      // A section that is the name itself is this car told in another car's
      // article: the Hillman Avenger's "Plymouth Cricket", the Alto's "Nissan Pixo".
      const sec = section ? plain(section).replace(/\b(?:1[89]|20)\d\d\b/g, " ").replace(/\s+/g, " ").trim() : "";
      const ownStory = !!sec && (sec === core || sec === make + " " + core || sec.endsWith(" " + make + " " + core));
      const byTitle = titled(at.to), bySection = !byTitle && !!section && !ownStory && titled(section) && hasSection(at.to, section);
      if (!byTitle && !bySection) return;
      // The name's own page, whichever car points at it, and its own generations.
      if ((home && at.to === home.to) || genArticles.has(at.to)) return;
      const c = carOf(at.to, h.n);
      if (!c) { if (byTitle && plain(at.to) !== plain(bare(h.n.wp))) free++; return; }
      if (seen.has(c.id) || c.familyOf === h.n.id) return;
      if (shortName(core) && plain(c.make) !== make) return;
      seen.add(c.id);
      list.push(bySection ? [c.id, e.text.replace(/'{2,}/g, "").trim()] : [c.id]);
    });
    // Only a name when every car it lists is in the graph: a listed page with none
    // may be this car's own article, as the BMW i3 page lists the I01.
    const hasGenerations = h.n.type === "family" && genOf(h).length > 0;
    let index = h.index && !free && list.length >= 2 && !hasGenerations;
    // A car, not a name, built in the very years of one it lists is that car twice
    // in the graph (the Ford Falcon and the Falcon (Australia)). A name takes its
    // first car's years, so for a name this says nothing.
    if (!index) for (let i = list.length - 1; i >= 0; i--) {
      const c = byId.get(list[i][0]);
      if (Number.isFinite(c.year) && c.year === h.n.year && c.end === h.n.end) { twice.push([h.n.id, c.id]); list.splice(i, 1); }
    }
    if (!list.length) return;
    index = index && list.length >= 2;
    if (out[h.n.id] && out[h.n.id].cars.length >= list.length) return;
    out[h.n.id] = index ? { page: h.page, index: true, cars: list } : h.index ? { page: h.page, cars: list } : { page: h.page, own: true, cars: list };
  });

  // Cars of one make and one name that no holder above joined: the two Ford Pumas
  // (no car holds "Ford Puma"), the Fiat 600 and the Fiat 600 (2023) (joined by
  // their hatnotes, with no index). The name's index page, or a hatnote of one
  // car's article naming the other's, says they are different cars. A hatnote
  // pointing at an overview or a generation does not: the Corolla (E210) is a
  // Corolla.
  const covered = new Set();
  Object.entries(out).forEach(([h, e]) => { covered.add(h); e.cars.forEach(([id]) => covered.add(id)); });
  const articleOf = n => { const a = own(bare(n.wp)); return a && !a.missing ? a.to : null; };
  const bareLabel = n => String(n.label).replace(/\s*\([^()]*\)\s*$/, "").trim();
  const groups = new Map();
  candidates.forEach(n => {
    if (n.retired || !n.make || plain(n.label) === plain(n.make) || !plain(bareLabel(n))) return;
    const k = plain(n.make) + "|" + plain(bareLabel(n));
    (groups.get(k) || groups.set(k, []).get(k)).push(n);
  });
  const pending = [];
  groups.forEach((ns, k) => {
    const byArt = new Map();
    const rank = (n, a) => (fullName(n) === plain(a.replace(/\s*\([^()]*\)\s*$/, "")) || fullName(n) === plain(a) ? 4 : 0) +
      (bare(n.wp) === a ? 2 : 0) + (n.type === "family" ? 1 : 0) + (/^llm-related-/.test(n.id) ? 0 : 1);
    ns.forEach(n => { const a = articleOf(n); if (a && (!byArt.has(a) || rank(n, a) > rank(byArt.get(a), a))) byArt.set(a, n); });
    const members = [...byArt.entries()].map(([a, n]) => ({ a, n }));
    if (members.length < 2 || members.every(m => covered.has(m.n.id))) return;
    const lead = members.find(m => !/\(/.test(m.n.label)) || members[0];
    pending.push({ k, members, name: `${lead.n.make} ${bareLabel(lead.n)}` });
  });
  const idx = await lookUp(pending.flatMap(p => [p.name, p.name + " (disambiguation)"]), cache); save();
  const idxPage = p => [p.name, p.name + " (disambiguation)"].map(idx).find(x => x && !x.missing && x.index);
  const ptext = await wikitexts([...pending.map(idxPage).filter(Boolean).map(x => x.to), ...pending.flatMap(p => p.members.map(m => m.a))], cache); save();
  const OVERVIEW_RE = /overview|overall|all (?:models|generations|versions)|generation|series as a whole|predecessor|successor|earlier|later model/i;
  const hatTargets = new Map();
  pending.forEach(p => p.members.forEach(m => {
    const head = ptext(m.a).split(/\n==/)[0];
    hatTargets.set(m.a, (head.match(HAT_RE) || []).filter(t => !OVERVIEW_RE.test(t))
      .flatMap(t => t.replace(/^\{\{|\}\}$/g, "").split("|").slice(1)).map(s => s.replace(/\[\[|\]\]/g, "").split("#")[0].trim()).filter(Boolean));
  }));
  const hatLook = await lookUp([...hatTargets.values()].flat(), cache); save();
  const pidxLook = await lookUp(pending.flatMap(p => { const x = idxPage(p); return x ? entriesOf(ptext(x.to)).map(e => e.page) : []; }), cache); save();
  let minted = 0, joined = 0;
  pending.forEach(p => {
    const byA = new Map(p.members.map(m => [m.a, m]));
    const confirmed = new Set();
    const x = idxPage(p);
    if (x) entriesOf(ptext(x.to)).forEach(e => { const at = pidxLook(e.page); if (at && !at.missing && !at.fragment && byA.has(at.to)) confirmed.add(at.to); });
    p.members.forEach(m => (hatTargets.get(m.a) || []).forEach(t => {
      const at = hatLook(t);
      if (at && !at.missing && at.to !== m.a && byA.has(at.to)) { confirmed.add(m.a); confirmed.add(at.to); }
    }));
    let ms = p.members.filter(m => confirmed.has(m.a));
    // The same car twice in the graph, or a generation beside its nameplate.
    ms = ms.filter(m => !ms.some(o => o !== m && o.n.familyOf == null && (o.n.generations || []).some(id => {
      const g = byId.get(id); return g && !g.retired && Number.isFinite(g.year) && g.year === m.n.year && g.end === m.n.end;
    })));
    if (ms.length < 2) return;
    // The car holding the bare name, confirmed or not, holds the group.
    const holders2 = p.members.filter(m => plain(bareLabel(m.n)) === plain(m.n.label));
    const isTwice = (a, b) => twice.some(([x1, y1]) => (x1 === a && y1 === b) || (x1 === b && y1 === a)) ||
      (Number.isFinite(a && byId.get(a).year) && byId.get(a).year === byId.get(b).year && byId.get(a).end === byId.get(b).end);
    if (holders2.length === 1) {
      const h = holders2[0].n;
      const list = ms.filter(m => m.n !== h && !isTwice(h.id, m.n.id)).map(m => [m.n.id]);
      if (!list.length) return;
      const prev = out[h.id];
      if (prev) { list.forEach(c => { if (!prev.cars.some(d => d[0] === c[0])) prev.cars.push(c); }); }
      else if (!confirmed.has(articleOf(h))) return;
      else out[h.id] = { page: x ? x.to : articleOf(h), own: true, cars: list };
      joined++;
    } else if (!holders2.length && x) {
      const key = "name:" + plain(p.name).replace(/ /g, "-");
      out[key] = { page: x.to, index: true, make: ms[0].n.make, label: bareLabel(ms[0].n), cars: ms.map(m => [m.n.id]) };
      minted++;
    }
  });
  console.log(`second pass: ${pending.length} names of several cars looked at, ${joined} joined to the car holding the name, ${minted} names of their own`);

  const ids = Object.keys(out).sort();
  const lines = ids.map(id => "  " + JSON.stringify(id) + ": " + JSON.stringify(out[id]) + ",");
  fs.writeFileSync(path.join(ROOT, "app/shared_names.js"),
    "// Generated by scripts/shared_names.js. Do not edit: change the rule.\nwindow.SHARED_NAMES = {\n" + lines.join("\n") + "\n};\n");
  console.log(`${ids.length} names, ${ids.reduce((a, id) => a + out[id].cars.length, 0)} cars listed under them, ` +
    `${ids.filter(id => out[id].index).length} of them names and not cars`);
  twice.forEach(([a, b]) => console.log(`same car twice, left out: ${a} and ${b}`));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
