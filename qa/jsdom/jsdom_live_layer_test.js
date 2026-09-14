// Real user request: "I want that whenever there is a new change in dbpedia,
// that the change gets added to my dataset as well, and without needing to do
// a full rebuild but to simply add the missing data where it's missing. ... it
// should also check whether it is overriding a user-entered car. If it is,
// then it should check whether the existing Wikipedia link for that car is
// there, because if it is, that means that the correct car with its data
// already existed that was previously created by the LLM. If the car exists
// but is without additional data, then the dbpedia car that was added can
// override whatever existed in that place before, since there was no
// information previously."
//
// Two halves.
//
// WHERE IT GOES. The findings used to live in localStorage: one browser, one
// device, gone with the site data, never in the repo. With serve.py there they
// go to live_layer.json instead -- an overlay replayed over the bake, on the
// same terms as llm_families.json, so a rebuild cannot clobber them and they
// cannot corrupt the bake.
//
// WHAT IT MAY OVERRIDE. merge() works on a snapshot taken before app.js
// applies the LLM layer and hand-added cars, so it could not see those cars at
// all -- and minted a SECOND node for one the model had already created. It
// consults them now, and the precedence is the one described above.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const SRC = fs.readFileSync(path.join(APP, "data_live.js"), "utf-8");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

// 1000 filler rows clear data_live's "short response" guard. After them come
// the rows this test is actually about, each aimed at a different kind of
// existing car.
function csv() {
  const rows = ['"s","y","e","mm","dd","rr","pp","ss"'];
  for (let i = 0; i < 1000; i++) rows.push(`"Filler_Car_${i}","2000","","Ford","","","",""`);
  // A car the local model created from its own Wikipedia article, link and all.
  rows.push('"Ford_Modelled","1995","2004","Ford","Alma Rourke","","",""');
  // A bare placeholder the model minted so an edge had somewhere to point.
  rows.push('"Ford_Placeholder","1998","2007","Ford","Bram Tolliver","","",""');
  // A car typed in by hand, with its own link and its own year already.
  rows.push('"Ford_Handtyped","1990","1999","Ford","Cerys Nolan","","",""');
  // A nameplate the model split, still in production. DBpedia's MIN() end
  // year for the article is its FIRST generation's, decades ago.
  rows.push('"Ford_Nameplate","1970","1978","Ford","","","",""');
  // A placeholder whose name matches an article ANOTHER car already claims.
  rows.push('"Ford_Contested","2001","2009","Ford","","","",""');
  // A car the user merged away into a nameplate. DBpedia still has it.
  rows.push('"Ford_Mergedaway","1980","1989","Ford","","","",""');
  // A car the user deleted outright.
  rows.push('"Ford_Deleted","1985","1990","Ford","","","",""');
  // A car the user renamed. It has no Wikipedia link, so only its old name
  // can find it.
  rows.push('"Ford_Oldname","1975","1982","Ford","","","",""');
  // A harvested car whose DBpedia row says it is related to a car the local
  // model created. That connection used to be dropped with no trace.
  rows.push('"Ford_Filler_Rel","2003","","Ford","","Ford_Modelled","",""');
  // Genuinely new: in DBpedia, nowhere in the graph.
  rows.push('"Ford_Brandnew","2024","","Ford","","","",""');
  return rows.join("\n");
}
const CSV = csv();

function baked() {
  const nodes = [{ id: "mk-ford", type: "make", label: "Ford", country: "US", year: null, wp: "Ford" }];
  const links = [];
  for (let i = 0; i < 1000; i++) {
    nodes.push({ id: `m-ford-filler-${i}`, type: "model", label: `Filler Car ${i}`, make: "Ford",
                 wp: `Filler Car ${i}`, year: 2000, end: null, designers: [], auto: true });
    links.push({ source: `m-ford-filler-${i}`, target: "mk-ford", type: "made" });
  }
  return { meta: { version: 5, generated: "2026-09-12", counts: {}, layout: "precomputed" }, nodes, links };
}

// The three cars that belong to OTHER layers -- added the way app.js adds
// them, i.e. after data_live has taken its snapshot.
function overlayCars() {
  return [
    // Created by the model, with a Wikipedia link: the correct car already.
    { id: "llm-ford-modelled", type: "model", label: "Modelled", make: "Ford",
      wp: "Ford Modelled", year: 1995, end: null, designers: ["Someone Real"],
      llmCreatedNode: true },
    // Minted as a placeholder: no link, no year, no end, no designers.
    { id: "llm-ford-placeholder", type: "model", label: "Placeholder", make: "Ford",
      wp: null, year: null, end: null, designers: [], llmCreatedNode: true },
    // Typed in by hand, with a link and a year of its own.
    { id: "usercar-ford-handtyped", type: "model", label: "Handtyped", make: "Ford",
      wp: "Ford Handtyped", year: 1990, end: null, designers: [], userAdded: true },
    // A nameplate the model split. Still in production, so end is null on
    // purpose -- backfillGenerationEnds owns that, derived from generations.
    { id: "llm-ford-nameplate", type: "family", label: "Nameplate", make: "Ford",
      wp: "Ford Nameplate", year: 1970, end: null, designers: [],
      generations: ["llm-ford-nameplate-g1"], llmCreatedNode: true },
    { id: "llm-ford-nameplate-g1", type: "model", label: "Gen1", make: "Ford",
      wp: null, year: 1970, end: null, designers: [], familyOf: "llm-ford-nameplate",
      llmCreatedNode: true },
    // A placeholder with no link of its own, whose make+label happens to name
    // an article a DIFFERENT car in the graph already claims.
    { id: "llm-ford-contested", type: "model", label: "Contested", make: "Ford",
      wp: null, year: null, end: null, designers: [], llmCreatedNode: true },
    { id: "llm-ford-contested-other", type: "model", label: "Something Else", make: "Ford",
      wp: "Ford Contested", year: 2001, end: null, designers: [], llmCreatedNode: true },
    // Merged away into a nameplate: retired, pointing at its replacement.
    { id: "llm-ford-mergedaway", type: "model", label: "Mergedaway", make: "Ford",
      wp: "Ford Mergedaway", year: 1980, end: null, designers: [],
      llmCreatedNode: true, retired: true, supersededBy: "llm-ford-merge-target" },
    { id: "llm-ford-merge-target", type: "model", label: "Merge Target", make: "Ford",
      wp: null, year: null, end: null, designers: [], llmCreatedNode: true },
    // Renamed, with no Wikipedia link -- only the old name can find it.
    { id: "llm-ford-renamed", type: "model", label: "Newname", make: "Ford",
      wp: null, year: null, end: null, designers: [], llmCreatedNode: true },
  ];
}

// One page load. `server` decides whether serve.py is there -- which is the
// whole difference between a finding that reaches the repo and one that does
// not. The overlay cars are pushed in AFTER data_live.js has run, exactly as
// app.js does it, then applyToOverlay is called the way boot() calls it.
async function load(opts) {
  opts = opts || {};
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="datastatus"></div>
     <div id="livetoast" hidden><span id="livetoast-msg"></span>
     <button id="livetoast-apply"></button><button id="livetoast-dismiss"></button></div>
     </body></html>`,
    { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  global.window = window; global.document = window.document;
  for (const k in (opts.storage || {})) window.localStorage.setItem(k, opts.storage[k]);
  window.CARDATA = baked();
  // Decisions the user has made, which DBpedia must not walk back. index.html
  // seeds this before data_live.js runs, so it is readable there.
  window.LLM_FAMILIES = {
    families: {},
    deletions: opts.withOverlay
      ? { "m-ford-deleted": { kind: "model", label: "Ford Deleted", cascadeIds: [] } } : {},
    renames: opts.withOverlay
      ? { "llm-ford-renamed": { label: "Newname", previousLabel: "Oldname", kind: "model" } } : {},
    purged: {}, __serverAvailable: false,
  };

  // serve.py, or not. The synchronous XHR is how data_live writes the layer.
  const posted = [];
  let layerFile = opts.layer || { newNodes: [], newLinks: [], updates: {} };
  window.XMLHttpRequest = function () {
    this.open = (m, u) => { this._m = m; this._u = u; };
    this.setRequestHeader = () => {};
    this.send = (body) => {
      if (!opts.server) { this.status = 0; return; }
      if (this._u === "/api/live-layer" && this._m === "POST") {
        posted.push(JSON.parse(body));
        layerFile = JSON.parse(body);
        this.status = 200; this.responseText = '{"ok":true}';
        return;
      }
      this.status = 404;
    };
  };
  window.LIVE_LAYER = Object.assign({}, layerFile, { __serverAvailable: !!opts.server });
  window.fetch = async (url) => {
    if (String(url).includes("dbpedia")) return { ok: true, text: async () => CSV };
    return { ok: true, json: async () => ({ query: { categorymembers: [] } }) };
  };
  if (opts.tinyCap) {
    // Shrink the cap rather than building a megabyte of fixture.
    window.eval(SRC.replace("const MAX_LAYER_BYTES = 1024 * 1024;", "const MAX_LAYER_BYTES = 200;"));
  } else {
    window.eval(SRC);
  }

  // app.js's job: the other layers arrive now, not before.
  if (opts.withOverlay) {
    overlayCars().forEach(n => window.CARDATA.nodes.push(n));
    window.CarWebLive.applyToOverlay();
  }
  window.CarWebLive.start();                   // sets the boot status line
  const status = window.document.getElementById("datastatus").textContent;
  if (!opts.noRefresh) await window.CarWebLive.refresh();
  if (opts.withOverlay) window.CarWebLive.applyToOverlay();  // as boot() does, after a refresh too

  const byId = new Map(window.CARDATA.nodes.map(n => [n.id, n]));
  return {
    window, posted, layerFile, byId, status,
    nodes: window.CARDATA.nodes,
    ls: window.localStorage.getItem("carweb_live_snapshot_v1"),
    toast: window.document.getElementById("livetoast-msg").textContent,
  };
}

(async () => {
  // ---------- where it goes ----------
  {
    const withServer = await load({ server: true });
    check("with serve.py there, the finding is written to the shared layer",
          withServer.posted.length === 1 &&
          withServer.posted[0].newNodes.some(n => n.wp === "Ford Brandnew"),
          withServer.posted.length + " post(s)");
    check("...and NOT left in this browser only",
          withServer.ls === null, withServer.ls ? "still in localStorage" : "clean");
    check("...and the toast says where it went, and that it needs committing",
          /live_layer\.json/.test(withServer.toast), withServer.toast.slice(-70));
    check("...stamped with the bake it was computed against",
          withServer.posted[0].generated === "2026-09-12", withServer.posted[0].generated);

    const noServer = await load({ server: false });
    check("with no serve.py it still works, in this browser only",
          noServer.posted.length === 0 && !!noServer.ls, noServer.posted.length + " post(s)");
    check("...and says so rather than implying it was published",
          /in this browser/.test(noServer.toast), noServer.toast.slice(-60));
  }

  // ---------- a layer already on disk is applied at boot ----------
  {
    const first = await load({ server: true });
    const layer = first.posted[0];
    const second = await load({ server: true, layer });
    const brandnew = second.nodes.filter(n => n.wp === "Ford Brandnew");
    check("a layer sitting in the file is spliced in at boot", brandnew.length === 1,
          brandnew.length + " copies");
    check("...and is not rediscovered as new afterwards",
          !/already saved from a previous one/.test(second.toast), second.toast.slice(0, 80));
  }

  // ---------- what it may override ----------
  {
    const r = await load({ server: true, withOverlay: true });

    // The duplicate this whole change exists to stop.
    ["Ford Modelled", "Ford Handtyped"].forEach(wp => {
      const all = r.nodes.filter(n => n.wp === wp);
      check(`"${wp}" is not minted a second time from DBpedia`, all.length === 1,
            all.length + " nodes: " + all.map(n => n.id).join(", "));
    });

    // Has a Wikipedia link -> it IS this car, created correctly. Gaps only.
    const modelled = r.byId.get("llm-ford-modelled");
    check("a model-created car with a Wikipedia link keeps what it already had",
          modelled.year === 1995 && JSON.stringify(modelled.designers) === '["Someone Real"]',
          modelled.year + " / " + JSON.stringify(modelled.designers));
    check("...and gains only what was genuinely missing", modelled.end === 2004, modelled.end);

    // Hand-typed, with a link and a year: same rule, no argument with it.
    const hand = r.byId.get("usercar-ford-handtyped");
    check("a hand-typed car's own year is not overwritten", hand.year === 1990, hand.year);
    check("...and it too gains only the gaps", hand.end === 1999 &&
          JSON.stringify(hand.designers) === '["Cerys Nolan"]',
          hand.end + " / " + JSON.stringify(hand.designers));

    // No link, nothing in it: a placeholder, so DBpedia takes the slot.
    const ph = r.byId.get("llm-ford-placeholder");
    check("a placeholder with no link and no data is given DBpedia's Wikipedia link",
          ph.wp === "Ford Placeholder", ph.wp);
    check("...and its year", ph.year === 1998, ph.year);
    check("...and its end year", ph.end === 2007, ph.end);
    check("...and its designers", JSON.stringify(ph.designers) === '["Bram Tolliver"]',
          JSON.stringify(ph.designers));
    check("...and is still not duplicated",
          r.nodes.filter(n => n.wp === "Ford Placeholder").length === 1);

    // Curated build-time data is untouched, as it always was.
    const filler = r.byId.get("m-ford-filler-5");
    check("a harvested car with no end year in DBpedia is left alone",
          filler.end === null, filler.end);
  }

  // ---------- a nameplate is recognised, then left alone ----------
  // Its years are not its own: backfillGenerationEnds derives them from its
  // generations, and it is open-ended on purpose while the newest one is. This
  // query asks DBpedia for MIN(productionEndYear), which for a multi-
  // generation article is the end of the FIRST generation -- so patching it in
  // would close a car that is still on sale, with a date from decades ago, and
  // do it after the backfill has run and cannot correct it.
  {
    const r = await load({ server: true, withOverlay: true });
    const fam = r.byId.get("llm-ford-nameplate");
    check("a nameplate still in production is NOT closed by DBpedia's earliest "
          + "end year", fam.end === null, fam.end);
    check("...and is still not minted a second time",
          r.nodes.filter(n => n.wp === "Ford Nameplate").length === 1,
          r.nodes.filter(n => n.wp === "Ford Nameplate").length + " nodes");
    const layer = r.posted[r.posted.length - 1];
    check("...and carries no patch at all", !layer.updates["llm-ford-nameplate"],
          JSON.stringify(layer.updates["llm-ford-nameplate"] || null));
  }

  // ---------- two cars must never claim the same article ----------
  {
    const r = await load({ server: true, withOverlay: true });
    const contested = r.byId.get("llm-ford-contested");
    const owner = r.byId.get("llm-ford-contested-other");
    check("a placeholder is not given a Wikipedia link another car already has",
          !contested.wp, contested.wp);
    check("...and the car that already had it keeps it", owner.wp === "Ford Contested", owner.wp);
    check("...so exactly one node claims that article",
          r.nodes.filter(n => n.wp === "Ford Contested").length === 1,
          r.nodes.filter(n => n.wp === "Ford Contested").length + " claimants");
    // And the row's data goes to the car that OWNS the article, not to the
    // one that merely shares its name: the link index is consulted before the
    // name index, so identity beats coincidence. The placeholder is left
    // completely alone, which is the right answer -- nothing actually
    // established that it is this car.
    check("...the article's owner is the one that gets the row's data",
          owner.end === 2009, owner.end);
    check("...and the name-only lookalike is left untouched",
          !contested.year && !contested.end && !contested.designers.length,
          contested.year + "/" + contested.end + "/" + contested.designers.length);
  }

  // ---------- decisions the user has made are not walked back ----------
  {
    const r = await load({ server: true, withOverlay: true });
    const layer = r.posted[r.posted.length - 1];
    const minted = new Set(layer.newNodes.map(n => n.wp));

    // A merge retires the car it merged away. Skipping retired nodes meant
    // DBpedia could not see it and minted it again -- so the merge had to be
    // redone after every refresh, which is work silently undone.
    check("a car merged away is recognised, not minted again",
          !minted.has("Ford Mergedaway"), [...minted].join(", "));
    // One VISIBLE copy. The retired node keeps the article title too --
    // supersedeStandalone copies it onto the replacement rather than moving
    // it, and a retired node is hidden everywhere -- so the pair sharing it
    // is normal. What must not exist is a third, freshly minted one.
    check("...and the graph still holds exactly one visible copy of it",
          r.nodes.filter(n => n.wp === "Ford Mergedaway" && !n.retired).length === 1,
          r.nodes.filter(n => n.wp === "Ford Mergedaway")
            .map(n => n.id + (n.retired ? " (retired)" : "")).join(", "));
    // The replacement is a bare placeholder, so it may take the data -- the
    // point of following supersededBy rather than just ignoring the match.
    const target = r.byId.get("llm-ford-merge-target");
    check("...and its replacement is the one that gets the row's data",
          target.wp === "Ford Mergedaway" && target.year === 1980, target.wp + " / " + target.year);

    // A deletion hides the car, so re-adding it looks harmless -- but the
    // layer then grows a node it re-adds on every boot for the deletion to
    // cancel again, forever.
    check("a car the user deleted is not re-added", !minted.has("Ford Deleted"),
          [...minted].join(", "));

    // A rename changes the label byName matches on, so the old name has to be
    // indexed too or DBpedia mints a duplicate.
    check("a renamed car is found by the name DBpedia still uses",
          !minted.has("Ford Oldname"), [...minted].join(", "));
    const renamed = r.byId.get("llm-ford-renamed");
    check("...and is patched rather than duplicated",
          renamed.year === 1975 && renamed.end === 1982,
          renamed.year + "-" + renamed.end);
    check("...and keeps the name you gave it", renamed.label === "Newname", renamed.label);
  }

  // ---------- a relation to a model-created car is kept ----------
  // It cannot be spliced at boot -- that car does not exist until app.js has
  // run -- so it is marked deferred and placed by applyToOverlay.
  {
    const r = await load({ server: true, withOverlay: true });
    const layer = r.posted[r.posted.length - 1];
    const rel = layer.newLinks.filter(l =>
      (l.source === "llm-ford-modelled" || l.target === "llm-ford-modelled") && l.type === "related");
    check("a connection DBpedia states to a model-created car is kept, not dropped",
          rel.length === 1, rel.length + " found");
    check("...and marked as needing the later pass", rel.length && rel[0].deferred === true,
          rel.length && JSON.stringify(rel[0]));
    // It cannot be placed on the run that FOUND it: the harvested end is a
    // car this same refresh just minted, and a minted car only enters the
    // graph on the next boot's splice. So the next load is where both ends
    // exist and the edge appears.
    const ownIds = l => [l.source, l.target].map(e => (e && e.id) || e);
    check("...and not placed yet on the run that found it -- neither end is in "
          + "the graph until the next load",
          r.window.CARDATA.links.filter(l => l.type === "related" &&
            ownIds(l).includes("llm-ford-modelled")).length === 0);

    const next = await load({ server: true, layer, withOverlay: true });
    const live = next.window.CARDATA.links.filter(l => l.type === "related" &&
      ownIds(l).includes("llm-ford-modelled"));
    check("...and really is in the graph on the next load", live.length === 1,
          live.length + " in the graph");
    // Twice must not mean two edges.
    next.window.CarWebLive.applyToOverlay();
    const again = next.window.CARDATA.links.filter(l => l.type === "related" &&
      ownIds(l).includes("llm-ford-modelled"));
    check("...and running that pass again adds nothing", again.length === 1, again.length);
  }

  // ---------- a stale layer says so instead of going quiet ----------
  {
    const first = await load({ server: true });
    const stale = Object.assign({}, first.posted[0], { generated: "2020-01-01" });
    const r = await load({ server: true, layer: stale, noRefresh: true });
    check("a layer from an earlier build is not applied",
          r.nodes.filter(n => n.wp === "Ford Brandnew").length === 0);
    check("...and the status line says so, naming the build it belongs to",
          /not being applied/.test(r.status) && /2020-01-01/.test(r.status), r.status);
  }

  // ---------- and it will not grow without limit ----------
  // live_layer_data.js is loaded by a blocking script on every page load, so
  // its size is first-paint cost for every visitor.
  {
    const r = await load({ server: true, tinyCap: true });
    check("past the cap the refresh refuses to grow the layer",
          r.posted.length === 0, r.posted.length + " post(s)");
    check("...and says to run a rebuild, which absorbs them properly",
          /[Rr]ebuild/.test(r.toast), r.toast.slice(0, 90));
    check("...and offers no Apply, since nothing was stored",
          r.window.document.getElementById("livetoast-apply").hidden === true);
  }

  // ---------- and the patches survive a reload ----------
  // They cannot land on data_live's own first pass: the cars they aim at do
  // not exist until app.js has run. So the layer has to still be carrying them
  // on the next load, and they have to land then too.
  {
    const first = await load({ server: true, withOverlay: true });
    const layer = first.posted[first.posted.length - 1];
    check("the layer keeps the patch for a car from another layer",
          !!layer.updates["llm-ford-placeholder"],
          JSON.stringify(Object.keys(layer.updates)));
    const second = await load({ server: true, layer, withOverlay: true });
    const ph = second.byId.get("llm-ford-placeholder");
    check("...and it lands again on the next load", ph.wp === "Ford Placeholder" && ph.year === 1998,
          ph.wp + " / " + ph.year);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
