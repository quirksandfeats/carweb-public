#!/usr/bin/env node
// Writes app/borrowed_plates.js: nameplates split from another car's article under their
// own name. The Toyota TownAce holds the LiteAce article's generations, the Vauxhall Midi
// the Isuzu Fargo's, the Audi "A3 Mk3" all four A3s. The name has no article of its own;
// the article read is another car's. What happens to each, by what the article is:
//   - a car's own article: its generations move to that car (the plain node of its name,
//     or a nameplate made for it), and the holder becomes
//       * an "also called" name of it, when the article's name or aka field gives it;
//       * the generation its code names ("A3 Mk3" is the third A3, "Truck 320" the 320);
//       * otherwise a car of its own (a badge, trim or electric version), on the
//         platform of the generation it was built beside, when its section gives years.
//   - another nameplate's generation article, a platform, a company or a race car: the
//     generations go, and the holder stays one car.
// Nothing here is written by hand.
//
//   node scripts/borrowed_plates.js CACHE.json          fetches articles into CACHE.json
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
    if (f === "borrowed_plates.js") { window.BORROWED_PLATES = {}; continue; }
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
const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const plain = s => String(s || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
// A field's whole value, over several lines ("{{ubl|...}}"), up to the next field.
const field = (text, name) => {
  const m = new RegExp("\\|\\s*" + name + "\\s*=", "i").exec(text || "");
  if (!m) return "";
  let i = m.index + m[0].length, depth = 0;
  for (; i < text.length; i++) {
    if (text.startsWith("{{", i) || text.startsWith("[[", i)) { depth++; i++; continue; }
    if (text.startsWith("}}", i) || text.startsWith("]]", i)) { if (depth === 0) break; depth--; i++; continue; }
    if (text[i] === "|" && depth === 0) break;
  }
  return text.slice(m.index + m[0].length, i).trim();
};
const wordsOf = s => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
(async () => {
  const cachePath = process.argv[2];
  if (!cachePath) { console.error("usage: node scripts/borrowed_plates.js CACHE.json"); process.exit(1); }
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf-8")) : {};
  const { LF, nodes } = bootApp(), window = global.window;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, "app/llm_families.json"), "utf-8"));
  const BR = window.BORROWED_READS || {};
  const live = n => n && !n.retired;
  const makes = new Map(nodes.filter(n => n.type === "make" && live(n)).map(n => [norm(n.label), n]));
  const readOf = id => (store.recheck[id] && store.recheck[id].sourceTitle) || (store.families[id] && store.families[id].sourceTitle) || null;
  // A title carries a car's name when its words begin with the name's, with or without
  // the make ("Mazda2" carries "Mazda 2"); a name in parts ("Fit/Jazz") by any part. A
  // name with a code the title lacks ("A3 Mk3", "Sprinter Trueno (AE91/92)") or another
  // bracket ("Fit (second generation)" against "(third generation)") is not carried.
  const carries = (title, n) => {
    const t = String(title).split("#")[0].trim(), mk = wordsOf(n.make);
    let tw = wordsOf(plain(t)); if (mk.every((w, i) => tw[i] === w)) tw = tw.slice(mk.length);
    const bracket = s => (/\(([^()]+)\)\s*$/.exec(s) || [])[1] || null;
    const hb = bracket(n.label), tb = bracket(t);
    if (hb && norm(hb) !== norm(tb || "")) return false;
    return plain(n.label).split("/").map(wordsOf).filter(w => w.length).some(w =>
      (w.every((x, i) => tw[i] === x)) || norm(tw.join("")) === norm(w.join("")));
  };
  const plates = nodes.filter(n => live(n) && n.type === "family" && n.make && !BR[n.id] && readOf(n.id));
  // Holders: the read's title is not the nameplate's own name (with or without the
  // trailing code a nameplate can carry), and the title begins with a make we have.
  const cands = plates.filter(n => {
    const A = readOf(n.id).split("#")[0].trim();
    if (norm(A) === norm(`${n.make} ${n.label}`) || norm(A) === norm(n.label)) return false;
    if (norm(plain(A)) === norm(`${n.make} ${plain(n.label)}`)) return false;
    const mk = [...makes.keys()].filter(k => norm(A).startsWith(k)).sort((a, b) => b.length - a.length)[0];
    // Its own article, with a code in its label the title lacks: a rename, not a borrowing.
    if (norm(plain(A)) === norm(`${n.make} ${plain(n.label)}`)) return false;
    // A brand's own nameplate ("Acadian Acadian") is a question of makes.
    if (norm(plain(n.label)) === norm(n.make)) return false;
    return !!mk && !carries(A, n);
  });
  const want = new Set();
  cands.forEach(n => { want.add(readOf(n.id).split("#")[0].trim()); want.add(`${n.make} ${n.label}`.trim()); });
  const need = [...want].filter(t => !(t in cache));
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    const r = await query({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", redirects: 1, titles: batch.join("|") });
    const q = r.query || {}, nm = new Map((q.normalized || []).map(x => [x.from, x.to]));
    const red = new Map((q.redirects || []).map(x => [x.from, x]));
    const pages = new Map((q.pages || []).map(p => [p.title, p]));
    batch.forEach(t => { let u = nm.get(t) || t; if (red.has(u)) u = red.get(u).to; const p = pages.get(u);
      cache[t] = { final: u, text: p && p.revisions ? p.revisions[0].slots.main.content : null }; });
    await new Promise(z => setTimeout(z, 400));
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const out = {}, report = [];
  for (const h of cands) {
    const A = readOf(h.id).split("#")[0].trim(), art = cache[A] || {}, text = art.text || "";
    const own = cache[`${h.make} ${h.label}`.trim()] || {};
    const fullName = `${h.make} ${h.label}`.trim();
    // The holder's own name with an article of its own, about something else than A.
    const ownArticle = own.text && !/\{\{\s*(?:disambiguation|dab|set index|car disambiguation)/i.test(own.text) && norm(own.final) !== norm(art.final);
    const box = (/\{\{\s*Infobox[ _]([^\n|}]+)/i.exec(text) || [])[1] || "";
    const genOwner = nodes.find(n => live(n) && n.familyOf && n.familyOf !== h.id && live(byId.get(n.familyOf)) &&
      norm(String(n.wp || "").split("#")[0]) === norm(art.final || A) && norm(n.wp) !== norm(byId.get(n.familyOf).wp));
    const genTitle = /\((?:[a-z]+ generation|[A-Z0-9][A-Za-z0-9/ ;–-]*)\)$/.test(art.final || A) &&
      nodes.some(n => live(n) && n.type === "family" && norm(n.wp) === norm(plain(art.final || A)));
    const pred = field(text, "predecessor");
    let action, why;
    if (!text) { report.push(`skip       ${h.id}: no article text for ${A}`); continue; }
    if (norm(plain(art.final || A)) === norm(`${h.make} ${plain(h.label)}`)) continue;   // its own article after all
    // The same model under another spelling of its maker (Lada 2101 / VAZ-2101, JiangLing /
    // JMC Baodian) is a question of makes, not of this list.
    const aMake = [...makes.keys()].filter(k => norm(art.final || A).startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (aMake && aMake !== norm(h.make) && norm((art.final || A)).slice(aMake.length) === norm(plain(h.label))) {
      report.push(`skip       ${h.make} ${h.label}: ${art.final || A} names the same model under another maker's name`); continue;
    }
    if (genOwner || genTitle) { action = "retire"; why = `${A} is a generation of ${genOwner ? byId.get(genOwner.familyOf).make + " " + byId.get(genOwner.familyOf).label : plain(A)}`; }
    else if (!/^automobile$/i.test(box.trim())) { action = "retire"; why = `${A} is ${box ? "a " + box.trim() + " article" : "no car article"}`; }
    else if (new RegExp("\\[\\[" + fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\]|]", "i").test(pred)) { action = "retire"; why = `${A} names the ${fullName} as its predecessor`; }
    else if (ownArticle) { action = "retire"; why = `the ${fullName} has an article of its own, ${own.final}`; }
    else action = "rehome";
    const row = { article: art.final || A, action, why: why || null };
    if (action === "rehome") {
      const title = art.final || A;
      const mkKey = [...makes.keys()].filter(k => norm(title).startsWith(k)).sort((a, b) => b.length - a.length)[0];
      const make = makes.get(mkKey);
      const subj = nodes.filter(n => live(n) && n.type === "model" && !n.familyOf && norm(String(n.wp || "").split("#")[0]) === norm(title) &&
        norm(`${n.make} ${n.label}`) === norm(title));
      if (subj.length === 1) row.subject = subj[0].id;
      else {
        let label = title.slice(make.label.length).replace(/^[\s\-]+/, "").trim();
        label = label.charAt(0).toUpperCase() + label.slice(1);
        row.mint = { id: "plate-" + norm(title), make: make.label, label, wp: title };
      }
      // What the holder becomes.
      const aka = field(text, "aka") + " " + field(text, "name");
      const hl = plain(h.label);
      const subjectLabel = row.subject ? byId.get(row.subject).label : row.mint.label;
      const codeOf = hl.toLowerCase().startsWith(subjectLabel.toLowerCase() + " ") ? hl.slice(subjectLabel.length + 1) : null;
      const gens = (h.generations || []).map(id => byId.get(id)).filter(live);
      let gen = null;
      // The generation its code names: after the nameplate's name ("A3 Mk3"), in its
      // brackets ("G90/EQ900 (HI)"), or the whole label ("300L").
      {
        // Its generations' own codes, without the holder's name each label begins with.
        const bare = gens.map(g => Object.assign({}, g, { label: subjectLabel + " " + (String(g.label).startsWith(h.label + " ") ? g.label.slice(h.label.length + 1) : g.label) }));
        const fakePlate = { generations: bare.map(g => g.id) }, bracket = (/\(([^()]+)\)\s*$/.exec(h.label) || [])[1];
        // "AE91/92" is AE91 and AE92.
        const parts = bracket ? bracket.split(/\s*\/\s*/) : [];
        const lead = parts.length ? (/^[A-Za-z]+/.exec(parts[0]) || [""])[0] : "";
        const each = parts.map(x => /^\d/.test(x) ? lead + x : x);
        const tries = [codeOf && `${subjectLabel} ${codeOf}`, codeOf && `${subjectLabel} (${codeOf})`, bracket && `${subjectLabel} (${bracket})`,
          ...each.map(x => `${subjectLabel} (${x})`), `${subjectLabel} (${hl})`];
        for (const t of tries.filter(Boolean)) { const g = LF.generationNamedBy(fakePlate, t, bare); if (g) { gen = g.id; break; } }
      }
      const akaName = /\(/.test(h.label) ? h.label : hl;
      if (new RegExp("(?:^|[^A-Za-z0-9])" + akaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:$|[^A-Za-z0-9])", "i").test(aka) && norm(h.make) === norm(make.label)) row.holderAs = "alias";
      else if (gen) { row.holderAs = "generation"; row.generation = gen; }
      else {
        row.holderAs = "car";
        // Its years and generation, from the section its name heads.
        const head = [...text.matchAll(/^(=+)\s*([^=\n]+?)\s*\1\s*$/gm)].find(m => norm(m[2]).includes(norm(hl)));
        const yrs = head && /((?:19|20)\d{2})\s*(?:[-–—]\s*((?:19|20)\d{2}|present))?/i.exec(head[2]);
        if (yrs) {
          // "300L (1965)" is one year; "Delica D:3 (2011–present)" is still built.
          const dash = /[-\u2013\u2014]/.test(head[2].slice(yrs.index));
          row.years = [Number(yrs[1]), yrs[2] && !/present/i.test(yrs[2]) ? Number(yrs[2]) : dash ? null : Number(yrs[1])];
          const fit = gens.filter(g => g.year != null && g.year <= row.years[0] && (g.end == null || g.end >= row.years[0]));
          if (fit.length) row.platformWith = fit.sort((a, b) => b.year - a.year)[0].id;
        }
      }
    }
    out[h.id] = row;
    report.push(`${action.padEnd(7)} ${h.make} ${h.label} <- ${row.article}` + (row.why ? ` (${row.why})` : "") +
      (row.subject ? ` -> ${row.subject}` : row.mint ? ` -> new ${row.mint.make} ${row.mint.label}` : "") +
      (row.holderAs ? `; holder: ${row.holderAs}${row.generation ? " " + byId.get(row.generation).label : ""}${row.years ? " " + row.years.join("-") : ""}${row.platformWith ? " on " + byId.get(row.platformWith).label : ""}` : ""));
  }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/borrowed_plates.js"),
    "// Generated by scripts/borrowed_plates.js. Do not edit: change the rule.\nwindow.BORROWED_PLATES = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  console.log(`${plates.length} nameplates, ${cands.length} read another car's article, ${lines.length} listed`);
  process.exit(0);
})();
