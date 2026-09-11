// Real bug report: "when I click to refresh, it always says 'DBpedia refresh:
// 2 new models, 2 new connections', then I click apply, and I click to refresh
// again and it shows the same message."
//
// Applying a refresh is supposed to be idempotent: whatever the refresh found
// gets spliced into the graph at the next boot, so the SAME DBpedia response
// re-merged afterwards should find nothing new. This walks that full round
// trip -- refresh, save delta, reload, refresh again against the identical
// response -- and asserts the second pass is clean.
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

// A DBpedia CSV: 1000 filler rows the graph already knows about (clears
// data_live's "short response" guard), plus two genuinely new models that
// are related to each other -- so one refresh yields 2 new models and, among
// other edges, the 2 new "made" connections plus their relation.
function buildCSV() {
  const header = '"s","y","e","mm","dd","rr","pp","ss"';
  const rows = [header];
  for (let i = 0; i < 1000; i++) {
    // Filler_Car_0 carries a production END year that the baked data below
    // does NOT have. That makes every merge produce a field update, which is
    // what forces a save on rounds that find nothing else -- and a save is
    // what triggers the trim. Without this the cycle can't be reproduced.
    rows.push(i === 0
      ? `"Filler_Car_0","2000","2019","Ford","","","",""`
      : `"Filler_Car_${i}","2000","","Ford","","","",""`);
  }
  rows.push('"Ford_Newthing","2025","","Ford","","Ford_Otherthing","",""');
  rows.push('"Ford_Otherthing","2025","","Ford","","Ford_Newthing","",""');
  return rows.join("\n");
}
const CSV = buildCSV();

function baseData() {
  const nodes = [{ id: "mk-ford", type: "make", label: "Ford", country: "US", year: null, wp: "Ford" }];
  const links = [];
  for (let i = 0; i < 1000; i++) {
    nodes.push({ id: `m-ford-filler-car-${i}`, type: "model", label: `Filler Car ${i}`,
                 make: "Ford", wp: `Filler Car ${i}`, year: 2000,
                 // car 5's end year is already IN the baked file -- a patch
                 // filling it in is redundant and should be dropped
                 end: i === 5 ? 2005 : null, designers: [], auto: true });
    links.push({ source: `m-ford-filler-car-${i}`, target: "mk-ford", type: "made" });
  }
  return { meta: { title: "T", version: 5, generated: "2026-08-27", counts: { nodes: nodes.length, links: links.length } }, nodes, links };
}

// One page load: fresh window, given localStorage contents, runs data_live and
// one forced refresh. Returns the toast text and what ended up in storage.
async function pageLoad(storage, opts) {
  opts = opts || {};
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="datastatus"></div>
     <div id="livetoast" hidden><span id="livetoast-msg"></span>
     <button id="livetoast-apply"></button><button id="livetoast-dismiss"></button></div>
     </body></html>`,
    { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const window = dom.window;
  global.window = window; global.document = window.document;
  for (const k in storage) window.localStorage.setItem(k, storage[k]);
  if (opts.blockWrites) {
    // Simulate a full quota / private browsing: setItem throws on the delta.
    const proto = Object.getPrototypeOf(window.localStorage);
    const real = proto.setItem;
    proto.setItem = function (k, v) {
      if (k === "carweb_live_snapshot_v1") { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      return real.call(this, k, v);
    };
  }
  window.CARDATA = baseData();
  window.fetch = async (url) => {
    if (String(url).includes("dbpedia")) return { ok: true, text: async () => CSV };
    return { ok: true, json: async () => ({ query: { categorymembers: [] } }) };  // no wiki-recent rows
  };
  window.eval(SRC);
  window.CarWebLive.start();
  const bootStatus = window.document.getElementById("datastatus").textContent;
  await window.CarWebLive.refresh();
  const out = {};
  for (const k of ["carweb_live_snapshot_v1", "carweb_live_checked_v1"]) {
    const v = window.localStorage.getItem(k); if (v) out[k] = v;
  }
  global.window.__ghostSpliced = window.CARDATA.nodes.some(n => n.id === "m-ford-ghost");
  return { toast: window.document.getElementById("livetoast-msg").textContent,
           hidden: window.document.getElementById("livetoast").hidden,
           applyHidden: window.document.getElementById("livetoast-apply").hidden,
           bootStatus,
           status: window.document.getElementById("datastatus").textContent,
           nodeCount: window.CARDATA.nodes.length, storage: out };
}

(async () => {
  // ---- first visit: nothing cached, the two new models are genuinely new ----
  const first = await pageLoad({});
  check("first refresh reports the new models", /new models/.test(first.toast), first.toast);
  check("first refresh persisted a delta", !!first.storage["carweb_live_snapshot_v1"],
        Object.keys(first.storage).join(","));

  // ---- Apply = location.reload(): same storage, fresh page, same response ----
  // Drop the throttle stamp, exactly like clicking the status to force a check.
  const storage2 = Object.assign({}, first.storage);
  delete storage2["carweb_live_checked_v1"];
  const second = await pageLoad(storage2);

  check("after Apply, the new models are actually in the graph",
        second.nodeCount > 1001, "nodes=" + second.nodeCount);
  check("SECOND refresh against the identical response finds nothing new",
        second.hidden === true || !/new models|new connections/.test(second.toast),
        "toast=" + JSON.stringify(second.toast) + " hidden=" + second.hidden);

  // ---- and a third, to be sure it has actually settled ----
  const storage3 = Object.assign({}, second.storage);
  delete storage3["carweb_live_checked_v1"];
  const third = await pageLoad(storage3);
  check("THIRD refresh still finds nothing new",
        third.hidden === true || !/new models|new connections/.test(third.toast),
        "toast=" + JSON.stringify(third.toast) + " hidden=" + third.hidden);

  // ---- the loop the user actually hit: the delta can't be stored ----------
  const blocked = await pageLoad({}, { blockWrites: true });
  check("a delta that can't be saved says so instead of failing silently",
        /wouldn't store|couldn't save/i.test(blocked.toast), blocked.toast);
  check("...and does NOT offer an Apply button that cannot work",
        blocked.applyHidden === true, "applyHidden=" + blocked.applyHidden);

  // ---- the misleading date label -----------------------------------------
  const labelled = await pageLoad(Object.assign({}, second.storage));
  check("boot status separates the bake date from the last-checked time",
        /built 2026-08-27/.test(labelled.bootStatus) && /last checked/.test(labelled.bootStatus),
        labelled.bootStatus);

  // ---- the loop that survived the first two fixes -------------------------
  // Fingerprint from the wild: a stored delta with NO new cars and NO new
  // connections, yet a refresh that still announces something every time.
  // A field patch that can never be applied -- its car is gone -- was being
  // carried in the delta forever and rediscovered on every merge.
  {
    const orphaned = JSON.stringify({
      version: 5, savedAt: 1,
      newNodes: [], newLinks: [],
      updates: { "m-ford-vanished": { end: 2011 } },      // no such car
    });
    const r = await pageLoad({ "carweb_live_snapshot_v1": orphaned });
    const stored = JSON.parse(r.storage["carweb_live_snapshot_v1"] || "{}");
    check("a patch whose car no longer exists is dropped, not carried forever",
          !Object.keys(stored.updates || {}).includes("m-ford-vanished"),
          JSON.stringify(stored.updates));
  }
  {
    // A patch the BAKED file already satisfies has nothing left to do.
    const satisfied = JSON.stringify({
      version: 5, savedAt: 1, newNodes: [], newLinks: [],
      updates: { "m-ford-filler-car-5": { end: 2005 } },   // already in data.js
    });
    const r = await pageLoad({ "carweb_live_snapshot_v1": satisfied });
    const stored = JSON.parse(r.storage["carweb_live_snapshot_v1"] || "{}");
    check("a patch the rebuilt data already contains is dropped",
          !Object.keys(stored.updates || {}).includes("m-ford-filler-car-5"),
          JSON.stringify(stored.updates));
    // ...but the one that IS still needed must survive, or it's lost on the
    // next boot and rediscovered forever -- the other half of the cycle.
    check("...while a patch that is still needed is kept",
          Object.keys(stored.updates || {}).includes("m-ford-filler-car-0"),
          JSON.stringify(stored.updates));
  }

  // ---- the alternation the user actually reported ------------------------
  // "It cycles between '0 new models...' and then when I try again it also
  // gets 'DBpedia refresh: 16 new models, 312 new connections, 1 updated'."
  //
  // A stuck field patch forces a save on the rounds that find nothing else,
  // and a save is what triggers the trim -- so the trim has to be measured
  // against the BAKED file, not against a graph that already has the cached
  // delta spliced into it. Four rounds, because a two-state cycle only shows
  // up if you go round it twice.
  {
    let storage = {};
    const seen = [];
    for (let round = 0; round < 4; round++) {
      const st = Object.assign({}, storage);
      delete st["carweb_live_checked_v1"];
      const r = await pageLoad(st);
      storage = r.storage;
      const d = JSON.parse(storage["carweb_live_snapshot_v1"] || "{}");
      seen.push({ toast: r.toast, nodes: (d.newNodes || []).length, links: (d.newLinks || []).length });
    }
    const sizes = seen.map(x => x.nodes + "n/" + x.links + "l");
    check("the saved result never gets emptied and refilled round after round",
          new Set(sizes).size === 1, sizes.join("  ->  "));
    const settled = seen.slice(1).every(x => !/new models/.test(x.toast) || x.toast === seen[1].toast);
    check("...and the refresh doesn't alternate between two different answers",
          settled, JSON.stringify(seen.map(x => x.toast)));
  }

  // ---- a delta from a PREVIOUS bake of data.js ---------------------------
  // The actual cause of the reported cycle. `version` is a schema version,
  // bumped by hand; rebuilding data.js regenerates every car and connection
  // but leaves it alone. So a delta computed against the old bake still looked
  // compatible, got spliced into a dataset it had never seen, and each refresh
  // found a different mismatch than the last -- the connection count swinging
  // by hundreds on every Apply.
  {
    const stale = JSON.stringify({
      version: 5, generated: "2026-07-13",          // an OLDER bake
      savedAt: 1,
      newNodes: [{ id: "m-ford-ghost", type: "model", label: "Ghost", make: "Ford",
                   wp: "Ford Ghost", year: 2001, end: null, designers: [], auto: true }],
      newLinks: [{ source: "m-ford-ghost", target: "mk-ford", type: "made" }],
      updates: { "m-ford-filler-car-0": { end: 1999 } },
    });
    const r = await pageLoad({ "carweb_live_snapshot_v1": stale });
    check("a delta from an older bake is NOT spliced into the rebuilt data",
          !window.__ghostSpliced, "ghost present: " + !!window.__ghostSpliced);
    const stored = JSON.parse(r.storage["carweb_live_snapshot_v1"] || "{}");
    check("...and what gets saved is stamped with the CURRENT bake",
          stored.generated === "2026-07-13" || stored.generated === undefined
            ? false : true,
          "stored.generated=" + stored.generated);
    check("...and doesn't carry the stale entries forward",
          !(stored.newNodes || []).some(n => n.id === "m-ford-ghost"),
          JSON.stringify((stored.newNodes || []).map(n => n.id)));
  }

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
