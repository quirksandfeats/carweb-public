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
  // A link endpoint as either a plain id or a whole node. `lid` below is the
  // same function for code that runs after boot; this copy exists because the
  // splice runs at the very top of this file, before that one is declared.
  const idOfEndpoint = v => (v && typeof v === "object" && v.id) ? v.id : v;
  const BAKED_LINK_KEYS = new Set();
  for (const l of window.CARDATA.links) {
    const s0 = idOfEndpoint(l.source), t0 = idOfEndpoint(l.target);
    BAKED_LINK_KEYS.add(s0 + "|" + t0 + "|" + l.type);
    BAKED_LINK_KEYS.add(t0 + "|" + s0 + "|" + l.type);
  }

  let bootSnap = null;
  let usingCache = false;

  // ---------- where a found change is KEPT ----------
  // Real user request: "I want that whenever there is a new change in dbpedia,
  // that the change gets added to my dataset as well, and without needing to
  // do a full rebuild but to simply add the missing data where it's missing."
  //
  // There are two places a delta can live and they are not equivalent:
  //
  //   serve.py's live_layer.json -- a real file, committed with the repo, read
  //     by every browser and by the hosted build. This is "my dataset".
  //   localStorage -- one browser on one device, gone with the site data. The
  //     only option when there is no serve.py, which is the hosted site.
  //
  // The file wins whenever it is there. It is an OVERLAY, replayed over the
  // baked data at boot exactly like llm_families.json, never a rewrite of
  // cars.json -- which is what makes it safe to have both: rebuild.sh
  // regenerates cars.json from a fresh harvest through the curated pipeline
  // and cannot clobber this, and this cannot corrupt the bake.
  const LIVE = (typeof window !== "undefined" && window.LIVE_LAYER) || null;
  const layerWritable = !!(LIVE && LIVE.__serverAvailable);
  function emptyDelta() { return { newNodes: [], newLinks: [], updates: {} }; }

  // Field-level patches onto EXISTING nodes -- fills gaps only, never
  // overwrites anything already there, which is the same "never touch curated
  // entries" rule merge() itself uses. This is what makes an "updated" diff
  // actually stick.
  //
  // Run twice per load, and it has to be: once from the boot splice, and again
  // from app.js once the LLM layer and hand-added cars are in the graph (see
  // applyToOverlay). A patch aimed at a car the local model created cannot
  // land on the first pass, because that car does not exist yet when this file
  // runs. Idempotent by construction -- every branch requires the field to be
  // empty -- so the second pass costs nothing and can only add.
  function applyPatches(updates, byId) {
    let n = 0;
    for (const id in (updates || {})) {
      const node = byId.get(id);
      if (!node) continue;
      const patch = updates[id] || {};
      // `wp` first: it is what makes the car's own article reachable, and
      // every later refresh matches on it.
      if (patch.wp && !node.wp) { node.wp = patch.wp; n++; }
      if (patch.year && !node.year) { node.year = patch.year; n++; }
      if (patch.end && !node.end) { node.end = patch.end; n++; }
      if (patch.designers && patch.designers.length && (!node.designers || !node.designers.length)) {
        node.designers = patch.designers; n++;
      }
    }
    return n;
  }

  // Splice one delta into the baked graph. Used for both sources, in order:
  // the file first (it is the shared, committed one), then this browser's
  // localStorage. Each entry is guarded individually, so a second delta
  // holding the same car or connection adds nothing twice.
  function spliceDelta(snap) {
    if (!snap || !Array.isArray(snap.newNodes) || !Array.isArray(snap.newLinks)) return 0;
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
      const s0 = idOfEndpoint(l.source), t0 = idOfEndpoint(l.target);
      linkSet.add(s0 + "|" + t0 + "|" + l.type);
      linkSet.add(t0 + "|" + s0 + "|" + l.type);
    }
    let spliced = 0;
    for (const n of snap.newNodes) {
      if (byId.has(n.id)) continue;
      if (n.wp && byWp.has(norm(n.wp))) continue; // same car, already present under a (possibly different) id
      window.CARDATA.nodes.push(n); byId.set(n.id, n); if (n.wp) byWp.set(norm(n.wp), n);
      spliced++;
    }
    for (const raw of snap.newLinks) {
      // Tolerate an endpoint written as a whole node rather than an id.
      // buildDelta no longer produces that (see its own comment on the
      // loop it caused), but a browser that ran an older build has one
      // of those deltas sitting in storage right now, and it should
      // recover on the next load rather than on the next refresh.
      const sid = idOfEndpoint(raw.source), tid = idOfEndpoint(raw.target);
      if (!sid || !tid) continue;
      const key = sid + "|" + tid + "|" + raw.type;
      if (linkSet.has(key)) continue;
      if (!byId.has(sid) || !byId.has(tid)) continue; // an endpoint didn't survive the rebuild -- drop it, don't dangle
      const l = Object.assign({}, raw, { source: sid, target: tid });
      window.CARDATA.links.push(l);
      linkSet.add(key);
      linkSet.add(tid + "|" + sid + "|" + raw.type);
      spliced++;
    }
    spliced += applyPatches(snap.updates, byId);
    if (spliced) {
      window.CARDATA.meta.counts = window.CARDATA.meta.counts || {};
      window.CARDATA.meta.counts.nodes = window.CARDATA.nodes.length;
      window.CARDATA.meta.counts.links = window.CARDATA.links.length;
    }
    return spliced;
  }

  // A delta is only ever valid for the exact bake it was computed against.
  //
  // Real bug report: the refresh cycling between two different answers, the
  // connection count swinging by ~300 either way on each Apply. `version` is
  // a SCHEMA version, bumped by hand when the shape of the data changes -- it
  // says nothing about the CONTENT. So when data.js is rebuilt (which the
  // "Rebuild all data from scratch" button makes easy, and which regenerates
  // every car and connection from a fresh harvest) the version stayed 5 and a
  // delta computed against the OLD bake still looked compatible. It got
  // spliced into a dataset it had never seen, where its ids and connections
  // only partly line up. Each refresh then found a different mismatch, saved
  // that, and the next one found the mismatch the other way round.
  function fitsThisBake(snap) {
    return !!snap && snap.version === window.CARDATA.meta.version &&
           snap.generated === window.CARDATA.meta.generated;
  }

  // ---------- the shared, committed layer ----------
  // Spliced FIRST, so the browser-local delta below only ever adds what this
  // machine has found and not yet published. A stale one is skipped rather
  // than deleted: unlike localStorage this is a file in the repo, and the
  // rebuild that made it stale is also the thing that absorbed its cars --
  // the next refresh rewrites it against the new bake anyway.
  let layerSpliced = 0;
  if (LIVE && fitsThisBake(LIVE)) {
    try { layerSpliced = spliceDelta(LIVE); } catch (e) {
      console.warn("CarWeb: the live layer could not be applied", e);
    }
  }

  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      if (fitsThisBake(snap) && Array.isArray(snap.newNodes) && Array.isArray(snap.newLinks)) {
        bootSnap = snap;
        if (spliceDelta(snap)) usingCache = true;
      } else if (snap) {
        // incompatible schema, or a delta from a previous bake -- the rebuilt
        // data.js wins outright, and starting clean is the only safe move
        localStorage.removeItem(LS_KEY);
      }
    }
  } catch (e) { /* file:// or private mode, quota exceeded, etc. -- fine, use baked data */ }

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
  // Which cars exist that the baked copy does not know about.
  //
  // merge() works on JSON.parse(PRISTINE) -- the graph as data.js shipped it
  // plus whatever was spliced at boot. It deliberately does NOT include the
  // LLM layer or hand-added cars, because those are applied by app.js after
  // this file has taken its snapshot. Which meant DBpedia could not see them
  // at all, and a car the local model had already created from its Wikipedia
  // article got minted a SECOND time from DBpedia under a different id: two
  // nodes for one car, each with half the story.
  //
  // Real user request: "it should also check whether it is overriding a
  // user-entered car. If it is, then it should check whether the existing
  // Wikipedia link for that car is there, because if it is, that means that
  // the correct car with its data already existed that was previously created
  // by the LLM. If the car exists but is without additional data, then the
  // dbpedia car that was added can override whatever existed in that place
  // before, since there was no information previously."
  //
  // So they are indexed separately and consulted for MATCHING. Separately,
  // because they are not the same kind of thing: a node here is not part of
  // the delta and must never be pushed into it -- it already exists, owned by
  // another layer. All this can do is recognise it and patch it.
  function liveIndex() {
    const byWp = new Map(), byName = new Map(), byId = new Map();
    const live = (typeof window !== "undefined" && window.CARDATA && window.CARDATA.nodes) || [];
    for (const n of live) {
      if (!n || n.retired) continue;
      byId.set(n.id, n);
      if (n.wp) byWp.set(norm(n.wp), n);
      // By name as well, because the case that matters most has no link to
      // match on: a placeholder is minted precisely BECAUSE nothing was known
      // about the car, so `wp` is null and an index keyed on it cannot see it.
      // "<make> <label>" is the same shape a DBpedia title takes once
      // underscores are gone, which is what makes them comparable at all.
      if ((n.type === "model" || n.type === "family") && n.make && n.label) {
        const k = norm(n.make + " " + n.label);
        if (k && !byName.has(k)) byName.set(k, n);
      }
    }
    return { byWp, byName, byId };
  }
  // Created by the local model or typed in by hand, as opposed to harvested or
  // hand-compiled. Same predicate llm_families.js's isHardData uses, inverted.
  const isSoftNode = n => !!(n && (n.userAdded || n.llmCreatedNode ||
                                   n.llmGenerated || n.mergeGenerated));
  // "Without additional data": a placeholder minted so an edge had something
  // to point at, never filled in. Deliberately not counting `label`/`make`,
  // which every minted node has by construction.
  const hasNoData = n => !!n && !n.year && !n.end && !(n.designers && n.designers.length);

  function merge(data, mainRows, recentRows) {
    const nodes = data.nodes, links = data.links;
    const LIVE_IDX = liveIndex();
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
      // Not in the baked copy -- but it may exist in a layer this file cannot
      // see. See liveIndex for why, and for the duplicate this prevents.
      const already = LIVE_IDX.byWp.get(key) || LIVE_IDX.byName.get(key);
      if (already) {
        if (already.type !== "model" && already.type !== "family") return null;
        // Hand-compiled data is never touched, by this or any other route.
        if (!isSoftNode(already) && !already.auto) return null;
        const patch = {};
        // It has a Wikipedia link, so it IS this car and was created
        // correctly -- the article behind the link is the same one DBpedia is
        // describing. Fill the gaps only; do not argue with what is there.
        // A placeholder with no link and nothing in it is the other case: it
        // was minted so an edge had somewhere to point, and there is no
        // information to lose, so DBpedia's version takes the slot.
        const blank = !already.wp && hasNoData(already);
        if (!already.wp) patch.wp = spaced;             // pure gain either way: it names the article
        if (y && (blank || !already.year)) patch.year = y;
        if (e && (blank || !already.end)) patch.end = e;
        if (dd && (blank || !already.designers || !already.designers.length)) {
          const ds = cleanDesigners(dd);
          if (ds.length) patch.designers = ds;
        }
        if (Object.keys(patch).length) {
          updated++;
          deltaUpdates[already.id] = Object.assign(deltaUpdates[already.id] || {}, patch);
        }
        // Deliberately returns null rather than the node: `already` belongs to
        // another layer and is not in `nodes`, so handing it back would let
        // pass 2 hang relation edges off a node this delta does not contain.
        // The patch is the whole contribution.
        return null;
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
      // A patch aimed at a car from the LLM layer or Add Car has no baked
      // entry to compare against, so redundancy is judged from the live node
      // instead. Still kept while anything it carries is unfilled -- dropping
      // it the moment it worked is what lost it on the next load and started
      // the wheel turning last time.
      const soft = live.get(id);
      const wantsSoft = soft && !BAKED_FIELDS.has(id) &&
        ((patch.wp && !soft.wp) || (patch.year && !soft.year) || (patch.end && !soft.end) ||
         (patch.designers && patch.designers.length && !(soft.designers || []).length));
      if (!wantsEnd && !wantsDesigners && !wantsSoft) continue;
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
    // Everything already found, from BOTH homes, unioned in -- never just
    // this round's own findings. The committed layer is folded in for the
    // same reason bootSnap is: a save replaces what was there, so anything
    // left out of this object is deleted, and a refresh that happened to find
    // less than a previous one would quietly throw the difference away.
    const fold = (prior) => {
      if (!prior || !fitsThisBake(prior)) return;
      const nodeIds = new Set(newNodes.map(n => n.id));
      newNodes = newNodes.concat((prior.newNodes || []).filter(n => !nodeIds.has(n.id)));
      const linkKeys = new Set();
      for (const l of newLinks) {
        linkKeys.add(lid(l.source) + "|" + lid(l.target) + "|" + l.type);
        linkKeys.add(lid(l.target) + "|" + lid(l.source) + "|" + l.type);
      }
      newLinks = newLinks.concat((prior.newLinks || []).filter(l =>
        !linkKeys.has(lid(l.source) + "|" + lid(l.target) + "|" + l.type)));
      updates = Object.assign({}, prior.updates || {}, updates); // this round's own patch wins on overlap -- most current
    };
    fold(bootSnap);
    fold(LIVE);
    [newNodes, newLinks] = prune(newNodes, newLinks);
    updates = pruneUpdates(updates);
    // THE loop. Reported three times, and this is what it was.
    //
    // The boot splice pushes the delta's own link objects into
    // CARDATA.links. app.js's d3 force simulation then replaces every link's
    // `source`/`target` STRING id with a live node OBJECT, in place -- on
    // those very objects, because the splice pushed the objects themselves
    // rather than copies. bootSnap still holds them, so by the time a later
    // refresh saves an updated delta, half its links describe their endpoints
    // as whole nodes.
    //
    // JSON.stringify then writes those nodes out inline: a 29KB delta became
    // 367KB, on its way to the quota. Worse, the next boot's splice tests
    // `byId.has(l.source)` against an object, which is never true, so it
    // dropped every one of them -- silently, the skip being the same one a
    // link with a genuinely missing endpoint takes. The graph came back
    // without them, merge rediscovered them, and round and round: the count
    // swinging between two values, the delta growing each time.
    //
    // It survived three earlier fixes to this file because none of them
    // reproduced with app.js loaded, and app.js is the only thing that
    // mutates those objects.
    //
    // So nothing is written in d3's shape. Endpoints back to plain ids, and
    // the simulation's own bookkeeping (x/y/vx/vy/index, added to spliced
    // NODES the same way) left out, which is what keeps the delta the size of
    // what was discovered rather than the size of the layout.
    const SIM_FIELDS = ["x", "y", "vx", "vy", "index", "fx", "fy", "sn", "tn", "r", "deg"];
    const flatLink = l => {
      const out = {};
      for (const k in l) if (SIM_FIELDS.indexOf(k) < 0) out[k] = l[k];
      out.source = lid(l.source); out.target = lid(l.target);
      return out;
    };
    const flatNode = n => {
      const out = {};
      for (const k in n) if (SIM_FIELDS.indexOf(k) < 0) out[k] = n[k];
      return out;
    };
    // generated: which bake of data.js this was computed against. See the
    // compatibility check at the top of this file.
    return { version, generated: window.CARDATA.meta.generated,
             savedAt: Date.now(), newNodes: newNodes.map(flatNode),
             newLinks: newLinks.map(flatLink), updates };
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
        let saved = true, saveErr = "", toFile = false;
        if (layerWritable) {
          // The shared home. Synchronous on purpose: the toast that follows
          // offers Apply, which reloads, and a reload that raced the write
          // would come back without the change and look exactly like the
          // failure this whole file has been chased around three times.
          try {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/api/live-layer", false);
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.send(JSON.stringify(delta));
            if (xhr.status === 200) {
              toFile = true;
              // What is on disk is now this. Without refreshing the in-memory
              // copy, a second refresh this session would union against the
              // layer as it was at page load and drop everything written
              // since -- and applyToOverlay would keep patching from a
              // version that no longer exists.
              if (LIVE) {
                LIVE.newNodes = delta.newNodes; LIVE.newLinks = delta.newLinks;
                LIVE.updates = delta.updates;
                LIVE.version = delta.version; LIVE.generated = delta.generated;
              }
              // Folded into the file, so this browser's private copy has
              // nothing left to contribute -- and leaving it would mean the
              // same cars arriving from two directions forever.
              try { localStorage.removeItem(LS_KEY); } catch (e) {}
            } else {
              saved = false; saveErr = "serve.py said " + xhr.status;
            }
          } catch (e) { saved = false; saveErr = (e && e.name) || "error"; }
        } else {
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(delta));
          } catch (e) {
            saved = false;
            saveErr = (e && e.name) || "error";
          }
        }
        if (!saved) {
          const kb = Math.round(JSON.stringify(delta).length / 1024);
          status("live · found changes, but couldn't save them (" + saveErr + ")");
          toast("Found " + diff.newModels + " new models and " + diff.newLinks +
                " new connections, but they couldn't be stored (" + saveErr +
                ", " + kb + "KB). They'll be found again next time rather than applied. " +
                (layerWritable
                  ? "serve.py is there but refused the write -- check its terminal."
                  : "Private browsing, a full storage quota, or opening index.html straight " +
                    "from disk will all do this."), { noApply: true });
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
              " · " + delta.newLinks.length + (toFile
                ? " now in live_layer.json -- commit it to publish them"
                : " held in this browser for the next reload"));
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
    // Re-run the field patches once the LLM layer and hand-added cars are in
    // the graph. Called from app.js's boot, after those are applied -- see
    // applyPatches for why once is not enough. Returns how many landed.
    applyToOverlay() {
      const byId = new Map();
      for (const n of window.CARDATA.nodes) byId.set(n.id, n);
      let n = 0;
      if (LIVE && fitsThisBake(LIVE)) n += applyPatches(LIVE.updates, byId);
      if (bootSnap) n += applyPatches(bootSnap.updates, byId);
      return n;
    },
  };
})();
