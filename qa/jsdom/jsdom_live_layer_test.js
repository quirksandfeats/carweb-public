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
  window.eval(SRC);

  // app.js's job: the other layers arrive now, not before.
  if (opts.withOverlay) {
    overlayCars().forEach(n => window.CARDATA.nodes.push(n));
    window.CarWebLive.applyToOverlay();
  }
  await window.CarWebLive.refresh();
  if (opts.withOverlay) window.CarWebLive.applyToOverlay();  // as boot() does, after a refresh too

  const byId = new Map(window.CARDATA.nodes.map(n => [n.id, n]));
  return {
    window, posted, layerFile, byId,
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
