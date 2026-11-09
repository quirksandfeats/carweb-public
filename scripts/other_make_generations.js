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
  // Every live make, for codes that begin with a maker's name of any size.
  const anyMake = nodes.filter(n => n.type === "make" && live(n) && norm(n.label).length >= 3)
    .map(n => words(n.label).join(" ")).filter(Boolean).sort((a, b) => b.length - a.length);
  const top = nodes.filter(n => live(n) && (n.type === "model" || n.type === "family") && !n.familyOf);
  // Cars by their whole name; a car placed under another nameplate still answers to its own.
  const named = new Map();
  nodes.filter(n => live(n) && (n.type === "model" || n.type === "family")).forEach(n => {
    const k = norm(n.make + " " + n.label); named.set(k, (named.get(k) || []).concat(n));
  });
  // A title as Wikipedia resolves it: { to, frag } or { missing }. Filled by the fetch below.
  const resolved = t => cache["resolve:" + t];
  const article = t => String(t || "").split("#")[0];
  function decide(pending) {
    const out = {}, report = [];
    for (const f of nodes.filter(n => live(n) && n.type === "family" && norm(n.label) !== norm(n.make))) {
      const gens = (f.generations || []).map(id => byId.get(id)).filter(live);
      if (gens.length < 2) continue;
      const host = article(f.wp);
      const text = textOf(host);
      const secs = text ? LF.wikitextSections(text) : [];
      const own = words(f.make).join(" ");
      const codeOf = g => String(g.label).startsWith(f.label + " ") ? g.label.slice(f.label.length + 1) : g.label;
      // A nameplate built on a run of another maker's cars, generation by generation
      // (HSV's Maloo on the Commodore VG to VZ), keeps them: decided after the loop.
      const mine = [];
      for (const g of gens) {
        const code = codeOf(g);
        if (/\bplatform\b/i.test(code) && g.year == null) {
          out[g.id] = { action: "retire", why: `"${code}" is a platform` };
          report.push(`retire   ${f.make} ${f.label}: ${code} (a platform with no years)`); continue;
        }
        const cw = words(code).join(" ") + " ";
        const mk = makes.find(m => cw.startsWith(m.w + " ") && m.w !== own && !own.startsWith(m.w + " "));
        // Another car's name: another maker's (any size), the nameplate's own maker
        // followed by another name ("Chevrolet City Express"), or another nameplate of
        // the same maker ("Atlas F22" on the Cabstar).
        const ownLead = norm(host) === norm(f.make + " " + f.label) && cw.startsWith(own + " ") && words(code).slice(own.split(" ").length).join(" ") !== words(f.label).join(" ");
        // "Atlas F22": another of the maker's nameplates, then a code with a digit that
        // is no year. It comes first: a small make may share the nameplate's name.
        const plateLead = !mk && !ownLead && /^[A-Za-z][\w-]*\s+[A-Za-z]*\d[\w\/-]*$/.test(code) && !/\s\d{4}$/.test(code) &&
          top.some(n => n !== f && norm(n.make) === norm(f.make) && words(n.label)[0] === words(code)[0] && words(n.label)[0] !== words(f.label)[0]);
        const otherLead = !plateLead && anyMake.find(w => cw.startsWith(w + " ") && w !== own && !own.startsWith(w + " "));
        // A car of its own, with an article of its own, read as a generation too: the
        // Lotus Europa S of 2006 under the Europa of 1966.
        const bare = code.replace(/\s*\(\d{4}[^()]*\)\s*$/, "");
        // Its whole name, nameplate and all, is that car's, and it starts the same year.
        const twins = (named.get(norm(f.make + " " + f.label + " " + bare)) || [])
          .filter(n => n !== f && n !== g && !n.familyOf && n.wp && norm(article(n.wp)) !== norm(host) &&
            n.year != null && g.year != null && Math.abs(n.year - g.year) <= 1);
        const twin = !mk && !otherLead && !ownLead && !plateLead && twins.length === 1 ? twins[0] : null;
        if (!mk && !otherLead && !ownLead && !plateLead && !twin) continue;
        // Numbered in the nameplate's own article: a generation under an earlier marque.
        if (text) {
          const sec = LF.generationSection(text, secs, { code, yearStart: g.year, yearEnd: g.end });
          const heading = sec ? text.slice(sec.at, (text.indexOf("\n", sec.at) + 1 || text.length + 1) - 1) : "";
          if (NUMBERED.test(heading)) { report.push(`keep     ${f.make} ${f.label}: ${code} (heading "${heading.replace(/=/g, "").trim()}")`); continue; }
        }
        // The generation it was built beside: the one under the nameplate's own name
        // ("Fiat 128", not the Egyptian "Nasr 128"), then the one whose years overlap it most.
        const ownName = x => { const w = words(codeOf(x)).join(" ") + " "; return w.startsWith(own + " ") || w.startsWith(words(f.label).join(" ") + " ") ? 1 : 0; };
        const ov = x => (x.year == null || g.year == null) ? -1 : Math.min(x.end == null ? 9999 : x.end, g.end == null ? 9999 : g.end) - Math.max(x.year, g.year);
        const base = gens.filter(x => x !== g && ov(x) >= 1 && !anyMake.some(w => (words(codeOf(x)).join(" ") + " ").startsWith(w + " ") && w !== own && !own.startsWith(w + " ")))
          .sort((a, b) => ownName(b) - ownName(a) || ov(b) - ov(a))[0] || null;
        let into = twin, how = twin ? ` (a car of its own: ${twin.wp})` : "";
        if (mk) {
          const label = code.split(/\s+/).slice(mk.w.split(" ").length).join(" ").trim();
          // The node of that name, where the graph has one.
          const same = label ? nodes.filter(n => live(n) && n.id !== g.id && (n.type === "model" || n.type === "family") && norm(n.make) === norm(mk.n.label) &&
            (norm(n.label) === norm(label) || norm(String(n.label).replace(/\s*\([^()]*\)\s*$/, "")) === norm(label.replace(/\s*\([^()]*\)\s*$/, "")))) : [];
          if (same.length === 1) into = same[0];
        }
        if (!into) {
          // Else the car Wikipedia gives that name: the title, or the section a redirect
          // names. Another maker's name may lose a bracket or a trailing code ("Holden
          // Captiva 5" -> "Holden Captiva"); the nameplate's own maker's name must be an
          // article of its own ("Ford Transit City"), and another of its nameplates must
          // land on a generation of that code ("Atlas F22" -> Nissan Atlas F22/H40).
          let t = (mk || otherLead || ownLead) ? code : f.make + " " + code;
          const probes = [t];
          for (; !ownLead;) {
            const shorter = /\s*\([^()]*\)\s*$/.test(t) ? t.replace(/\s*\([^()]*\)\s*$/, "")
              : (t.split(/\s+/).length > 2 && /\d/.test(t.split(/\s+/).pop()) ? t.split(/\s+/).slice(0, -1).join(" ") : null);
            if (!shorter || shorter === t) break;
            probes.push(t = shorter);
          }
          let waiting = false, why = "no car of that name";
          for (const p of probes) {
            const r = resolved(p);
            if (!r) { pending.add(p); waiting = true; break; }
            if (r.missing) continue;
            const hits = new Set();
            // A redirect into the nameplate's own article is a section of it, not that car.
            if (r.to !== p && article(r.to) === host) { if (ownLead) break; continue; }
            [p, r.frag].filter(Boolean).forEach(x => (named.get(norm(x)) || []).forEach(n => hits.add(n)));
            hits.delete(f); hits.delete(g);
            if (hits.size > 1) [...hits].forEach(n => { if (n.familyOf && hits.has(byId.get(n.familyOf))) hits.delete(n); });
            if (hits.size === 1) { into = [...hits][0]; how = ` (Wikipedia: ${p}${r.to !== p ? " -> " + r.to + (r.frag ? "#" + r.frag : "") : ""})`; break; }
            if (article(r.to) !== host) { why = `"${p}" is ${r.to}, no car of it`; break; }
          }
          if (waiting) continue;
          if (!into) { report.push(`not done ${f.make} ${f.label}: ${code} (${why})`); continue; }
        }
        // A node on the nameplate's own article is that car under another badge (Fiat Daily).
        if (norm(article(into.wp)) === norm(host)) { report.push(`keep     ${f.make} ${f.label}: ${code} (its node shares the article)`); continue; }
        // A generation of that car when the code names one: by number ("Suzuki Carry
        // (Third generation)"), by year ("Edsel Corsair (1958)") or by code ("Atlas F22").
        let donor = false;
        if (into.type === "family") {
          const gg = (into.generations || []).map(id => byId.get(id)).filter(live);
          const ord = (/\(([a-z]+ generation)\)/i.exec(code) || [])[1];
          const yr = +((/\((\d{4})\)\s*$/.exec(code) || [])[1] || 0);
          const tok = words(code).filter(w => /\d/.test(w) && !/^\d{4}$/.test(w));
          const pick = ord ? gg.filter(x => norm(x.label).includes(norm(ord)))
            : yr ? gg.filter(x => x.year === yr)
            : tok.length ? gg.filter(x => tok.every(w => words(x.label).includes(w))) : [];
          if (pick.length === 1) { into = pick[0]; donor = true; }
        }
        if (plateLead && !donor) { report.push(`not done ${f.make} ${f.label}: ${code} (no generation ${code} of the ${into.make} ${into.label})`); continue; }
        // Built beside the nameplate's generation only when it is another maker's.
        const besideId = !donor && !ownLead && !plateLead && !twin && base ? base.id : null;
        out[g.id] = { action: "merge", into: into.id, beside: besideId };
        mine.push([g.id, into, code]);
        report.push(`merge    ${f.make} ${f.label}: ${code} -> ${into.make} ${into.label}` + (besideId ? ` beside ${base.label}` : "") + how + "\t" + g.id);
      }
      const byMake = new Map();
      mine.forEach(([, into]) => byMake.set(norm(into.make), (byMake.get(norm(into.make)) || new Set()).add(into.id)));
      mine.forEach(([id, into, code]) => {
        if (byMake.get(norm(into.make)).size < 3) return;
        delete out[id];
        report.push(`keep     ${f.make} ${f.label}: ${code} (built on a run of ${into.make} cars)`);
      });
    }
    return { out, report: report.filter(l => !l.startsWith("merge") || out[l.split("\t")[1]]).map(l => l.split("\t")[0]) };
  }
  // Ask Wikipedia about the names the rule needs, then decide.
  // Each round may ask for a shorter name, so ask until nothing is left.
  let pending = new Set(), asked = 0;
  for (let round = 0; round < 6; round++) {
    pending = new Set();
    decide(pending);
    const ask = [...pending];
    if (!ask.length) break;
    for (let i = 0; i < ask.length; i += 50) {
      const titles = ask.slice(i, i + 50);
      const r = await query({ action: "query", titles: titles.join("|"), redirects: 1 });
      const q = r.query || {}, norms = new Map((q.normalized || []).map(x => [x.from, x.to])), reds = new Map((q.redirects || []).map(x => [x.from, x]));
      const pages = new Map((q.pages || []).map(p => [p.title, p]));
      titles.forEach(t => {
        const n = norms.get(t) || t, rd = reds.get(n), to = rd ? rd.to : n, pg = pages.get(to);
        cache["resolve:" + t] = !pg || pg.missing || pg.invalid ? { missing: true } : { to, frag: rd && rd.tofragment || null };
      });
    }
    asked += ask.length;
  }
  if (asked) fs.writeFileSync(cachePath, JSON.stringify(cache));
  pending = new Set();
  const { out, report } = decide(pending);
  if (pending.size) { process.stdout.write(`unresolved: ${[...pending].join(", ")}\n`); process.exit(1); }
  const lines = Object.keys(out).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
  fs.writeFileSync(path.join(ROOT, "app/other_make_generations.js"),
    "// Generated by scripts/other_make_generations.js. Do not edit: change the rule.\nwindow.OTHER_MAKE_GENERATIONS = {\n" + lines.join("\n") + "\n};\n");
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, report.sort().join("\n") + "\n");
  console.log(`${lines.length} rows`);
  process.exit(0);
})().catch(e => { process.stdout.write(String(e && e.stack || e) + "\n"); process.exit(1); });
