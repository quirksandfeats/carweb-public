/* The Car Web — live data layer.
 *
 * The graph you see boots instantly from the local snapshot (data.js, or a
 * newer cached snapshot in localStorage). In the background, every page load
 * re-queries the DBpedia SPARQL API (dbpedia.org/sparql, CORS-enabled) plus
 * the live Wikipedia category API for the newest model years, merges anything
 * new into the snapshot, and offers a one-click apply. Fully offline-safe:
 * if the APIs are unreachable you simply keep the last snapshot.
 *
 * Hand-curated layers (chief engineers, platform groups, verified core) are
 * never touched by a live refresh — DBpedia has no chief-engineer data.
 */
window.CarWebLive = (function () {
  "use strict";
  const LS_KEY = "carweb_live_snapshot_v1";
  const LS_TS = "carweb_live_checked_v1";
  const THROTTLE_MS = 10 * 60 * 1000;      // don't re-query more than every 10 min
  const MAX_NEW = 900;                      // sanity cap per refresh

  // ---------- boot-time snapshot splice (runs synchronously, before app.js) ----------
  // History: v1 was a wholesale swap (adopt-or-discard the whole cached
  // snapshot based on a node-count/date check) that broke as soon as the
  // baked data.js changed size. v2 fixed that by splicing in just the
  // elements from a cached FULL snapshot that weren't already present.
  //
  // v2 had its own bug though: it persisted the ENTIRE merged dataset
  // (nodes + links, several MB once the graph grew) to localStorage on
  // every refresh. Two consequences, both matching real bug reports:
  //   1. Safari's localStorage quota is much tighter than Chrome's, so
  //      localStorage.setItem() of a multi-MB string silently threw
  //      (caught by the empty try/catch below) — the cache never actually
  //      persisted, so every load re-showed the exact same "diff" forever.
  //   2. The splice only ever ADDED nodes/links that didn't already exist
  //      by id/wp. It had no path to apply a field-level UPDATE (like a
  //      newly-discovered production-end year or designer credit) onto a
  //      node that already existed in the fresh bake. So even on Chrome,
  //      where the setItem succeeded, the same "1 updated" kept recurring
  //      on every check — the update was saved into the cached blob but
  //      never actually reapplied to the live node on the next boot, so
  //      merge() rediscovered the identical "missing" field forever.
  //
  // v3: persist only the DELTA (brand-new nodes/links plus a small
  // id -> {end, designers} patch map for existing nodes), which is tiny
  // (tens of KB, not MB) and comfortably inside every browser's quota, and
  // apply that patch map to matching existing nodes at boot so an update
  // actually sticks and never needs rediscovering.
  // Kept at module scope (not just local to this boot-splice block) so a
  // LATER refresh() call in the SAME page load -- e.g. clicking "click to
  // refresh from DBpedia now" more than once before ever reloading, or the
  // automatic post-boot refresh finding something new -- can fold this
  // session's already-spliced delta into whatever it saves next, instead of
  // overwriting it. See refresh()'s own comment on the loop this fixes.
  // What data.js itself shipped, captured BEFORE the splice below mutates
  // window.CARDATA. Everything after this point sees a graph that already
  // includes the cached delta, so "is this already in the baked file?" cannot
  // be answered from window.CARDATA -- it has to be answered from here.
  // Getting that wrong is what made the refresh alternate between two
  // results; see buildDelta's prune for the full story.
  const BAKED_NODE_IDS = new Set(window.CARDATA.nodes.map(n => n.id));
  // Just the two fields a live refresh can fill in, as data.js shipped them.
  // A patch is only redundant once a REBUILD has absorbed it -- checking the
  // live node instead would drop the patch the moment the splice applied it,
  // which loses it on the next boot and starts the same wheel turning again.
  const BAKED_FIELDS = new Map(window.CARDATA.nodes.map(
    n => [n.id, { end: n.end, designers: (n.designers || []).length }]));
  const BAKED_LINK_KEYS = new Set();
  for (const l of window.CARDATA.links) {
    BAKED_LINK_KEYS.add(l.source + "|" + l.target + "|" + l.type);
    BAKED_LINK_KEYS.add(l.target + "|" + l.source + "|" + l.type);
  }

  let bootSnap = null;
  let usingCache = false;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      // Real bug report: the refresh cycling between two different answers,
      // the connection count swinging by ~300 either way on each Apply.
      //
      // Root cause: `version` is a SCHEMA version, bumped by hand when the
      // shape of the data changes. It says nothing about the CONTENT. So when
      // data.js is rebuilt -- which the "Rebuild all data from scratch" button
      // now makes easy, and which regenerates every car and connection from a
      // fresh harvest -- the version stays 5 and a delta computed against the
      // OLD bake still looked compatible. It got spliced into a dataset it had
      // never seen, where its ids and connections only partly line up. Each
      // refresh then found a different mismatch, saved that, and the next one
      // found the mismatch the other way round: the cycle, and the ~300-link
      // swing.
      //
      // A cached delta is only ever valid for the exact bake it was computed
      // against, so the build date has to be part of the compatibility check.
      // After a rebuild the stale delta is now discarded, the next refresh
      // finds whatever is genuinely new once, and it settles.
      const sameBake = snap && snap.version === window.CARDATA.meta.version &&
                       snap.generated === window.CARDATA.meta.generated;
      if (sameBake && Array.isArray(snap.newNodes) && Array.isArray(snap.newLinks)) {
        bootSnap = snap;
        const byId = new Map(), byWp = new Map(), linkSet = new Set();
        for (const n of window.CARDATA.nodes) { byId.set(n.id, n); if (n.wp) byWp.set(norm(n.wp), n); }
        // Both directions. merge()'s own addLink treats A->B and B->A as the
        // same connection (it checks k1 AND k2), but this splice only ever
        // recorded and tested the one direction it happened to be written in.
        // So a connection the baked data holds as B->A did not match a cached
        // delta holding it as A->B, and got spliced in a second time -- a
        // duplicate edge, and one more chance for the two halves of this file
        // to disagree about what is already present.
        for (const l of window.CARDATA.links) {
          linkSet.add(l.source + "|" + l.target + "|" + l.type);
          linkSet.add(l.target + "|" + l.source + "|" + l.type);
        }
        let spliced = 0;
        for (const n of snap.newNodes) {
          if (byId.has(n.id)) continue;
          if (n.wp && byWp.has(norm(n.wp))) continue; // same car, already present under a (possibly different) id
          window.CARDATA.nodes.push(n); byId.set(n.id, n); if (n.wp) byWp.set(norm(n.wp), n);
          spliced++;
        }
        for (const l of snap.newLinks) {
          const key = l.source + "|" + l.target + "|" + l.type;
          if (linkSet.has(key)) continue;
          if (!byId.has(l.source) || !byId.has(l.target)) continue; // an endpoint didn't survive the rebuild -- drop it, don't dangle
          window.CARDATA.links.push(l);
          linkSet.add(key);
          linkSet.add(l.target + "|" + l.source + "|" + l.type);
          spliced++;
        }
        // field-level patches onto EXISTING nodes -- fills gaps only, never
        // overwrites anything the baked/curated data already has, mirroring
        // the exact same "never touch curated entries" rule merge() itself
        // uses. This is what makes an "updated" diff actually stick.
        if (snap.updates) {
          for (const id in snap.updates) {
            const node = byId.get(id);
            if (!node) continue;
            const patch = snap.updates[id];
            if (patch.end && !node.end) { node.end = patch.end; spliced++; }
            if (patch.designers && patch.designers.length && (!node.designers || !node.designers.length)) {
              node.designers = patch.designers; spliced++;
            }
          }
        }
        if (spliced) {
          window.CARDATA.meta.counts = window.CARDATA.meta.counts || {};
          window.CARDATA.meta.counts.nodes = window.CARDATA.nodes.length;
          window.CARDATA.meta.counts.links = window.CARDATA.links.length;
          usingCache = true;
        }
      } else if (snap) {
        // incompatible schema, or a delta from a previous bake — the rebuilt
        // data.js wins outright, and starting clean is the only safe move
        localStorage.removeItem(LS_KEY);
      }
    }
  } catch (e) { /* file:// or private mode, quota exceeded, etc. — fine, use baked data */ }

  // pristine copy for merging (before app.js mutates links/nodes in place)
  const PRISTINE = JSON.stringify(window.CARDATA);

  // ---------- helpers ----------
  function norm(s) {
    return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  function slug(s) {
    return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
  }
  const deunder = s => s.replace(/_/g, " ").trim();

  function parseCSV(text) {
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); field = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
      else if (c !== "\r") field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const MAKE_ALIAS = { "Mercedes-AMG": "Mercedes-Benz", "Mercedes-Maybach": "Mercedes-Benz",
    "Mercedes": "Mercedes-Benz", "VW": "Volkswagen", "Skoda": "Škoda", "Citroen": "Citroën",
    "Alfa": "Alfa Romeo", "Aston": "Aston Martin", "DeLorean": "DMC", "Range Rover": "Land Rover" };

  const JUNK = /(List of|Category:|Template:|\(disambiguation\)|^Timeline| lineup$)/i;

  function cleanDesigners(raw) {
    const out = [];
    for (const part of raw.split("~")) {
      let p = deunder(part).replace(/\s*\(.*?\)$/, "").trim().replace(/[.;]+$/, "");
      if (!p) continue;
      for (let c of p.split(/\s+and\s+|,|&|;|\//)) {
        c = c.trim();
        if (!c || c.length > 38 || /\d/.test(c) || c.split(" ").length > 4) continue;
        if (/design|styling|studio|centre|center|team|department|gmbh|s\.p\.a|inc\.|ltd|company|unknown|various|in-house/i.test(c)) continue;
        if (!out.some(x => norm(x) === norm(c))) out.push(c);
      }
    }
    return out;
  }

  const status = txt => { const el = document.getElementById("datastatus"); if (el) el.textContent = txt; };

  // ---------- the live queries ----------
  const Q_MAIN = `SELECT ?s ?y (MIN(?ey) AS ?e)
(GROUP_CONCAT(DISTINCT ?mf;separator="~") AS ?mm)
(GROUP_CONCAT(DISTINCT ?dn;separator="~") AS ?dd)
(GROUP_CONCAT(DISTINCT ?rl;separator="~") AS ?rr)
(GROUP_CONCAT(DISTINCT ?pr;separator="~") AS ?pp)
(GROUP_CONCAT(DISTINCT ?sc;separator="~") AS ?ss)
WHERE{
 ?k skos:broader dbc:Cars_by_year_of_introduction.
 ?c dct:subject ?k.
 BIND(xsd:integer(STRAFTER(STR(?k),"in_")) AS ?y)FILTER(?y>=1959)
 BIND(STRAFTER(STR(?c),"resource/") AS ?s)
 OPTIONAL{?c dbo:productionEndYear ?b.BIND(year(?b) AS ?ey)}
 OPTIONAL{?c dbo:manufacturer ?m.BIND(STRAFTER(STR(?m),"resource/") AS ?mf)}
 OPTIONAL{?c dbo:designer|dbp:designer ?d.BIND(IF(isIRI(?d),STRAFTER(STR(?d),"resource/"),STR(?d)) AS ?dn)}
 OPTIONAL{?c dbo:relatedMeanOfTransportation ?r.BIND(STRAFTER(STR(?r),"resource/") AS ?rl)}
 OPTIONAL{?c dbo:predecessor ?p2.BIND(STRAFTER(STR(?p2),"resource/") AS ?pr)}
 OPTIONAL{?c dbo:successor ?s2.BIND(STRAFTER(STR(?s2),"resource/") AS ?sc)}
}GROUP BY ?s ?y`;

  async function sparql(query) {
    const r = await fetch("https://dbpedia.org/sparql", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/csv" },
      body: "query=" + encodeURIComponent(query) + "&timeout=120000",
    });
    if (!r.ok) throw new Error("DBpedia HTTP " + r.status);
    return r.text();
  }

  async function wikiRecent() {
    const now = new Date().getFullYear();
    const out = [];
    for (let y = now - 2; y <= now + 1; y++) {
      let cont = "";
      do {
        const u = "https://en.wikipedia.org/w/api.php?action=query&list=categorymembers" +
          "&cmtitle=Category:Cars_introduced_in_" + y + "&cmlimit=500&cmtype=page&format=json&origin=*" +
          (cont ? "&cmcontinue=" + encodeURIComponent(cont) : "");
        const j = await (await fetch(u)).json();
        for (const m of (j.query && j.query.categorymembers) || []) out.push([m.title, y]);
        cont = (j.continue && j.continue.cmcontinue) || "";
      } while (cont);
    }
    return out;
  }

  // ---------- merge ----------
  function merge(data, mainRows, recentRows) {
    const nodes = data.nodes, links = data.links;
    const byWp = new Map(), byId = new Map(), makeByLabel = new Map(), personByNorm = new Map();
    for (const n of nodes) {
      byId.set(n.id, n);
      if (n.wp) byWp.set(norm(n.wp), n);
      if (n.type === "make") makeByLabel.set(n.label, n);
      if (n.type === "person") personByNorm.set(norm(n.label), n);
    }
    const linkSet = new Set(links.map(l => l.source + "|" + l.target + "|" + l.type));
    // delta accumulators -- what actually needs to persist to localStorage.
    // Kept tiny on purpose: full nodes/links snapshot is MBs, this is KBs.
    const deltaNodes = [], deltaLinks = [], deltaUpdates = {};
    const addLink = (s, t, type, note) => {
      const k1 = s + "|" + t + "|" + type, k2 = t + "|" + s + "|" + type;
      if (linkSet.has(k1) || linkSet.has(k2)) return false;
      linkSet.add(k1);
      const l = { source: s, target: t, type };
      if (note) l.note = note;
      links.push(l); deltaLinks.push(l); return true;
    };
    // brand list from the graph itself (longest-prefix match)
    const brands = [...makeByLabel.keys()].concat(Object.keys(MAKE_ALIAS)).sort((a, b) => b.length - a.length);
    function splitTitle(spaced) {
      const low = spaced.toLowerCase();
      for (const b of brands) {
        if (low.startsWith(b.toLowerCase() + " ")) {
          return [MAKE_ALIAS[b] || b, spaced.slice(b.length).trim()];
        }
      }
      return [null, null];
    }
    function ensureMake(label, country) {
      let mk = makeByLabel.get(label);
      if (mk) return mk;
      let id = "mk-" + slug(label);
      while (byId.has(id)) id += "-2";
      mk = { id, type: "make", label, country: country || "Unknown", year: null, wp: label };
      nodes.push(mk); deltaNodes.push(mk); byId.set(id, mk); makeByLabel.set(label, mk);
      return mk;
    }
    function ensurePerson(name) {
      let p = personByNorm.get(norm(name));
      if (p) return p;
      let id = "p-" + slug(name);
      while (byId.has(id)) id += "-2";
      p = { id, type: "person", kind: "person", label: name, roles: ["designer"],
            born: null, died: null, country: null, wp: name };
      nodes.push(p); deltaNodes.push(p); byId.set(id, p); personByNorm.set(norm(name), p);
      return p;
    }

    let newModels = 0, newLinks = 0, updated = 0;
    const pendingRel = [];

    function upsert(title, y, e, mm, dd) {
      if (JUNK.test(title)) return null;
      const spaced = deunder(title);
      const key = norm(spaced);
      let n = byWp.get(key);
      if (n) {
        if (n.type !== "model") return n;
        if (n.auto) {  // never touch curated entries
          let ch = false;
          const patch = {};
          if (e && !n.end && e >= n.year) { n.end = e; ch = true; patch.end = e; }
          if (dd && (!n.designers || !n.designers.length)) {
            const ds = cleanDesigners(dd);
            if (ds.length) {
              n.designers = ds; ch = true; patch.designers = ds;
              for (const d of ds) { const p = ensurePerson(d); if (addLink(n.id, p.id, "designed")) newLinks++; }
            }
          }
          if (ch) { updated++; deltaUpdates[n.id] = Object.assign(deltaUpdates[n.id] || {}, patch); }
        }
        return n;
      }
      if (y < 1959 || y > new Date().getFullYear() + 2) return null;
      let [make, rest] = splitTitle(spaced);
      if (!make && mm) {
        for (const m of mm.split("~")) {
          if (!m) continue;
          let cand = deunder(m.replace(/_\(.*?\)$/, ""))
            .replace(/\s+(Motors?|Motor Company|Auto|Automobiles?|Automotive|Cars|Group|Corporation|Holdings?|Company|Inc\.?|Ltd\.?|AG|GmbH)$/i, "").trim();
          if (cand && cand.length <= 28) { make = MAKE_ALIAS[cand] || cand; rest = spaced; break; }
        }
      }
      if (!make) {
        const w = spaced.split(" (")[0].split(" ");
        if (w.length > 1 && /^[A-Z0-9]/.test(w[0])) { make = w[0]; rest = spaced.slice(make.length).trim(); }
      }
      if (!make) return null;
      const mk = ensureMake(make);
      let base = "m-" + slug(make) + "-" + slug(rest || spaced);
      let id = base, i = 2;
      while (byId.has(id)) id = base + "-" + (i++);
      n = { id, type: "model", label: rest || spaced, make, year: y,
            end: e || null, designers: [], wp: spaced, auto: true, live: true };
      nodes.push(n); deltaNodes.push(n); byId.set(id, n); byWp.set(key, n);
      if (addLink(id, mk.id, "made")) newLinks++;
      if (dd) {
        n.designers = cleanDesigners(dd);
        for (const d of n.designers) { const p = ensurePerson(d); if (addLink(id, p.id, "designed")) newLinks++; }
      }
      newModels++;
      return n;
    }

    // pass 1: rows
    for (const r of mainRows) {
      if (r.length < 8) continue;
      const [s, y, e, mm, dd, rr, pp, ss] = r;
      const n = upsert(s, +y, e ? +e : null, mm, dd);
      if (n && n.type === "model") pendingRel.push([n, rr, pp, ss]);
      if (newModels > MAX_NEW) throw new Error("suspicious refresh: too many new models");
    }
    for (const [title, y] of recentRows) upsert(title.replace(/ /g, "_"), +y, null, "", "");
    // pass 2: model↔model edges (both endpoints must exist)
    for (const [n, rr, pp, ss] of pendingRel) {
      for (const t of (ss || "").split("~")) {
        const o = t && byWp.get(norm(deunder(t)));
        if (o && o.type === "model" && o.id !== n.id && addLink(n.id, o.id, "succession")) newLinks++;
      }
      for (const t of (pp || "").split("~")) {
        const o = t && byWp.get(norm(deunder(t)));
        if (o && o.type === "model" && o.id !== n.id && addLink(o.id, n.id, "succession")) newLinks++;
      }
      for (const t of (rr || "").split("~")) {
        const o = t && byWp.get(norm(deunder(t)));
        if (o && o.type === "model" && o.id !== n.id && addLink(n.id, o.id, "related")) newLinks++;
      }
    }
    return { newModels, newLinks, updated, deltaNodes, deltaLinks, deltaUpdates };
  }

  // Builds the delta actually written to localStorage -- unioned with
  // whatever was ALREADY spliced in at boot this session (bootSnap), never
  // just this round's own findings alone. Real bug report: clicking
  // "refresh from DBpedia now" a second time (or "Apply" -> reload ->
  // refresh again) before ever fully round-tripping through a reload could
  // silently DISCARD an earlier, not-yet-applied delta -- localStorage.
  // setItem(LS_KEY, ...) always fully REPLACED the previous entry with only
  // THIS call's diff.deltaNodes/deltaLinks/deltaUpdates (computed relative
  // to PRISTINE, the state at THIS PAGE'S load, which never changes mid-
  // session even though window.CARDATA itself only gets the delta spliced
  // in on the NEXT reload). If a second refresh() ran before that reload
  // happened, it found a smaller/different diff against the SAME stale
  // PRISTINE baseline (DBpedia's SPARQL endpoint isn't perfectly
  // deterministic run to run either, which made the sizes vary too) and
  // overwrote LS_KEY with THAT alone -- permanently losing the earlier,
  // larger delta, which had never actually been applied to window.CARDATA
  // yet. The next reload only spliced in the smaller, most-recent delta;
  // the "lost" one's models/links were still genuinely missing from
  // DBpedia's perspective, so the NEXT refresh rediscovered them fresh --
  // reproducing the original, larger diff again. Repeat that with the app
  // open across a few refresh/apply cycles and it looks exactly like an
  // endless loop cycling between two diff sizes. Unioning here means
  // nothing already found (whether or not it's been reloaded/spliced into
  // window.CARDATA yet) can ever be silently dropped by a later refresh.
  // Shared by buildDelta and refresh below, so both must be able to see it.
  // app.js's D3 simulation rewrites every link's source/target from a string
  // id to a live node object, in place, on CARDATA.links -- so anything
  // reading those after boot has to cope with both shapes.
  const lid = v => (v && typeof v === "object" && v.id) ? v.id : v;
  // A field patch that cannot be applied is the quietest way to loop
  // forever, and it leaves exactly the fingerprint seen in the wild: a
  // stored delta with no new cars and no new connections, yet a refresh
  // that still announces something every single time.
  //
  // The boot splice applies a patch only if the car is still in the graph
  // and the field is still empty. Nothing ever removed a patch that failed
  // both tests, so a patch aimed at a car that has since been renamed,
  // rebuilt under a different id or deleted just sat in the delta -- never
  // applied, therefore never present in the data the next merge compares
  // against, therefore rediscovered as "1 updated", forever.
  //
  // Drop a patch once it is either impossible (no such car) or unnecessary
  // (the field it fills is already filled). Both mean the same thing: there
  // is nothing left for it to do.
  const pruneUpdates = (updates) => {
    const kept = {};
    const live = new Map(window.CARDATA.nodes.map(n => [n.id, n]));
    for (const id in (updates || {})) {
      const patch = updates[id] || {};
      // Gone: no such car in the baked file OR in the live graph. Nothing can
      // ever apply this, so carrying it just means rediscovering it forever.
      if (!live.has(id) && !BAKED_NODE_IDS.has(id)) continue;
      // Redundant: a REBUILD has since filled the field itself. Deliberately
      // measured against the baked file, not the live node -- the splice fills
      // the live node on every boot, so testing that would throw the patch
      // away the moment it started working and lose it on the next load.
      const baked = BAKED_FIELDS.get(id);
      const wantsEnd = patch.end && !(baked && baked.end);
      const wantsDesigners = patch.designers && patch.designers.length &&
                             !(baked && baked.designers);
      if (!wantsEnd && !wantsDesigners) continue;
      kept[id] = patch;
    }
    return kept;
  };

  function buildDelta(diff) {
    const version = window.CARDATA.meta.version;
    let newNodes = diff.deltaNodes, newLinks = diff.deltaLinks, updates = diff.deltaUpdates;
    // Real bug report: the same "N new models, N new connections" reappearing
    // after every Apply. One way that happens with no visible error at all:
    // this delta only ever GREW. Every refresh concatenated the previous
    // delta onto the new one, and nothing ever removed an entry once a later
    // data.js rebake had absorbed it -- so months of live discoveries piled
    // up in a single localStorage string. Once that string crosses the
    // browser's quota, setItem throws, the throw used to be swallowed
    // silently, and the refresh could never persist again: every visit
    // rediscovered the identical diff forever.
    //
    // Anything already in the baked data is redundant here (the boot splice
    // skips it anyway), so drop it. That keeps the delta proportional to
    // what is genuinely not yet baked, instead of to how long this browser
    // profile has existed.
    // NOTE the source/target unwrapping. By the time a refresh runs, app.js's
    // D3 force simulation has replaced every link's `source`/`target` STRING
    // id with a live node OBJECT, in place, on this very array. Reading them
    // raw here produced "[object Object]|[object Object]|related" for every
    // single link, so this set matched nothing and the prune below silently
    // did nothing at all. Anything walking CARDATA.links after boot has to
    // handle both shapes.
    // Real bug report: the refresh ALTERNATED -- "0 new models, 0 new
    // connections, 1 updated", then on the next go "16 new models, 312 new
    // connections, 1 updated", back and forth forever.
    //
    // This trim was the cause, and it was reading the wrong thing. It asked
    // "is this entry already in window.CARDATA?" -- but by the time a refresh
    // runs, the boot splice has already put the entire cached delta INTO
    // window.CARDATA. So every entry looked redundant and the trim deleted the
    // lot, saving an empty delta. Next page load had nothing to splice, the
    // graph was back to bare data.js, and the refresh rediscovered all 16 cars
    // and 312 connections -- which then got saved, spliced, and wiped again.
    //
    // The single stuck field patch is what kept the wheel turning: it forced a
    // save on the rounds that found nothing else, and a save is what triggers
    // the trim.
    //
    // BAKED_* is the graph as data.js shipped it, snapshotted before the
    // splice ran. That is the only thing that can answer "has a rebuild
    // absorbed this yet?", which is what this trim is actually for.
    const bakedIds = BAKED_NODE_IDS;
    const bakedLinks = BAKED_LINK_KEYS;
    const prune = (nodes, links) => [
      nodes.filter(n => !bakedIds.has(n.id)),
      links.filter(l => !bakedLinks.has(lid(l.source) + "|" + lid(l.target) + "|" + l.type) &&
                        !bakedLinks.has(lid(l.target) + "|" + lid(l.source) + "|" + l.type)),
    ];
    if (bootSnap && bootSnap.version === version &&
        bootSnap.generated === window.CARDATA.meta.generated) {
      const nodeIds = new Set(newNodes.map(n => n.id));
      newNodes = newNodes.concat((bootSnap.newNodes || []).filter(n => !nodeIds.has(n.id)));
      const linkKeys = new Set(newLinks.map(l => l.source + "|" + l.target + "|" + l.type));
      newLinks = newLinks.concat((bootSnap.newLinks || []).filter(l => !linkKeys.has(l.source + "|" + l.target + "|" + l.type)));
      updates = Object.assign({}, bootSnap.updates || {}, updates); // this round's own patch wins on overlap -- most current
    }
    [newNodes, newLinks] = prune(newNodes, newLinks);
    updates = pruneUpdates(updates);
    // generated: which bake of data.js this was computed against. See the
    // compatibility check at the top of this file.
    return { version, generated: window.CARDATA.meta.generated,
             savedAt: Date.now(), newNodes, newLinks, updates };
  }

  // ---------- refresh orchestration ----------
  async function refresh(force) {
    try {
      const last = +(localStorage.getItem(LS_TS) || 0);
      if (!force && Date.now() - last < THROTTLE_MS) { status(liveLabel()); return; }
    } catch (e) {}
    status("checking DBpedia…");
    try {
      const [csv, recent] = await Promise.all([sparql(Q_MAIN), wikiRecent().catch(() => [])]);
      const rows = parseCSV(csv); rows.shift(); // header
      if (rows.length < 1000) throw new Error("short response");
      const data = JSON.parse(PRISTINE);
      const diff = merge(data, rows, recent);
      try { localStorage.setItem(LS_TS, String(Date.now())); } catch (e) {}
      // Count only what a reload could actually apply. An "update" the boot
      // splice will reject (car gone, or field already filled) is not a change
      // the user can act on, and offering Apply for it is what made the
      // refresh look like it was going in circles.
      const applicableUpdates = Object.keys(pruneUpdates(diff.deltaUpdates || {})).length;
      if (diff.newModels || diff.newLinks || applicableUpdates) {
        // Persist only the delta -- new nodes/links plus a small field-patch
        // map -- not the whole multi-MB dataset. Keeps this comfortably
        // inside every browser's localStorage quota (Safari's is much
        // tighter than Chrome's) and is what the boot splice above expects.
        const delta = buildDelta(diff);
        // This used to be `catch (e) {}`. That empty catch WAS the bug the
        // user actually saw: when the write failed (quota, private mode,
        // file://), nothing said so -- the toast still offered "Apply",
        // Apply still reloaded the page, and the reload had nothing cached
        // to splice, so the very same diff came back every single time. An
        // infinite loop with no error message anywhere. If we can't save
        // it, say so, and don't offer an Apply that cannot work.
        let saved = true, saveErr = "";
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(delta));
        } catch (e) {
          saved = false;
          saveErr = (e && e.name) || "error";
        }
        if (!saved) {
          const kb = Math.round(JSON.stringify(delta).length / 1024);
          status("live · found changes, but couldn't save them (" + saveErr + ")");
          toast("Found " + diff.newModels + " new models and " + diff.newLinks +
                " new connections, but this browser wouldn't store them (" + saveErr +
                ", " + kb + "KB). They'll be found again next time rather than applied. " +
                "Private browsing, a full storage quota, or opening index.html straight " +
                "from disk will all do this.", { noApply: true });
          return;
        }
        // Real bug report, the third time this loop has been reported: refresh
        // says "0 new models, 283 new connections", Apply, refresh says "1 new
        // connection", Apply, and then 283 again -- with the connection count
        // swinging between two values forever.
        //
        // Every previous round of this was diagnosed by reasoning backwards
        // from the numbers, because the mechanism itself said nothing. It is
        // not reproducible from the DBpedia response alone (eight cycles
        // against the real harvest CSV, full and deliberately partial, settle
        // after one), so the cause is in the round trip through localStorage
        // and the boot splice -- and that is exactly the part with no output.
        //
        // This is the fingerprint, stated directly. A link this round found as
        // NEW that was ALREADY sitting in the delta we had cached means the
        // splice did not stick: it was saved, the reload was supposed to put
        // it into the graph, and the graph came back without it. Nothing else
        // produces that combination. Saying so turns the loop from something
        // to be deduced into something the toast tells you, and names the
        // usual causes rather than offering an Apply that will not hold.
        const priorKeys = new Set();
        for (const l of ((bootSnap && bootSnap.newLinks) || [])) {
          priorKeys.add(lid(l.source) + "|" + lid(l.target) + "|" + l.type);
          priorKeys.add(lid(l.target) + "|" + lid(l.source) + "|" + l.type);
        }
        const rediscovered = (diff.deltaLinks || []).filter(l =>
          priorKeys.has(lid(l.source) + "|" + lid(l.target) + "|" + l.type)).length;
        bootSnap = delta; // so a THIRD refresh this same session also accumulates correctly
        if (rediscovered) {
          status("live · " + rediscovered + " connections keep coming back -- the saved "
                 + "update is not being applied");
          toast("This refresh found " + rediscovered + " connection(s) that were already "
                + "saved from a previous one, which means Apply is not sticking: the update "
                + "is stored, but the page comes back without it. Usually the data snapshot "
                + "was rebuilt underneath it (the cached update only fits the bake it was "
                + "computed against, " + (bootSnap.generated || "unknown") + "), or this "
                + "browser is clearing site data between visits. Applying again will not "
                + "help until that stops.", { noApply: true });
          return;
        }
        status("live · +" + diff.newModels + " models, +" + diff.newLinks + " connections found");
        toast("DBpedia refresh: " + diff.newModels + " new models, " + diff.newLinks +
              " new connections" + (applicableUpdates ? ", " + applicableUpdates + " updated" : "") +
              " · " + delta.newLinks.length + " held for the next reload");
      } else {
        status(liveLabel(true));
      }
    } catch (e) {
      status((usingCache ? "snapshot (cached) · " : "snapshot · ") + "DBpedia unreachable");
    }
  }
  function liveLabel(fresh) {
    const t = new Date();
    return "live · in sync with DBpedia" + (fresh ? " · checked " +
      t.getHours().toString().padStart(2, "0") + ":" + t.getMinutes().toString().padStart(2, "0") : "");
  }
  // Real bug report: "it constantly says that the snapshot is from the 13th
  // of July, even though I just clicked to refresh it."
  //
  // Two different dates were being shown as if they were one. meta.generated
  // is when the DBpedia data was BAKED into data.js -- it is a property of
  // the file on disk and correctly never changes when you refresh. What the
  // user was actually looking for is when this browser last CHECKED against
  // live DBpedia, which is the thing a refresh does move. The old label
  // showed only the first, and Apply reloads the page, which reset the label
  // straight back to it -- so a refresh that had genuinely just run looked
  // like it had done nothing at all.
  //
  // Show both, clearly labelled as the different things they are.
  function bootLabel() {
    const baked = "snapshot · built " + window.CARDATA.meta.generated + (usingCache ? " + local updates" : "");
    let last = 0;
    try { last = +(localStorage.getItem(LS_TS) || 0); } catch (e) {}
    if (!last) return baked;
    const d = new Date(last), now = new Date();
    const hhmm = d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
    const sameDay = d.toDateString() === now.toDateString();
    return baked + " · last checked " + (sameDay ? hhmm : d.toISOString().slice(0, 10) + " " + hhmm);
  }
  function toast(msg, opts) {
    const el = document.getElementById("livetoast");
    if (!el) return;
    document.getElementById("livetoast-msg").textContent = msg;
    el.hidden = false;
    const apply = document.getElementById("livetoast-apply");
    // Nothing was stored, so reloading would just re-run the same check and
    // land in the same place. Offering the button anyway is what made this
    // feel like "Apply doesn't work" rather than "this didn't save".
    if (apply) {
      apply.hidden = !!(opts && opts.noApply);
      apply.onclick = () => location.reload();
    }
    document.getElementById("livetoast-dismiss").onclick = () => el.hidden = true;
  }

  return {
    start() {
      status(bootLabel());
      const st = document.getElementById("datastatus");
      if (st) { st.style.cursor = "pointer"; st.title = "click to refresh from DBpedia now"; st.onclick = () => refresh(true); }
      setTimeout(() => refresh(false), 1200);   // let first paint happen, then go live
    },
    refresh: () => refresh(true),
  };
})();
