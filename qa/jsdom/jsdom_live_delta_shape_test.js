// THE refresh loop. Reported three times, fixed three times, and none of the
// earlier fixes touched what was actually wrong -- because none of the tests
// for them loaded app.js, and app.js is the only thing that causes it.
//
// What happens: the boot splice pushes the cached delta's own link OBJECTS
// into CARDATA.links. app.js's d3 force simulation then replaces every link's
// `source`/`target` string id with a live node object, in place -- on those
// very objects, since they were pushed rather than copied. bootSnap still
// holds them, so the next refresh saves a delta whose links describe their
// endpoints as whole nodes. JSON.stringify writes those nodes out inline (a
// 29KB delta became 367KB, heading for the quota), and the next boot's splice
// tests `byId.has(l.source)` against an object -- never true -- so it drops
// every one of them, silently. The graph comes back without them, merge
// rediscovers them, and round it goes: the connection count swinging between
// two values, the delta growing each cycle.
//
// The user's own sequence: "DBpedia refresh: 0 new models, 1 new connections.
// Hit Apply. Click to refresh again. This refresh found 283 connection(s) that
// were already saved from a previous one."
//
// Reproducing it needs BOTH halves at once, which is the trap: a round that
// finds something new (so a delta is written) AND a previous delta already
// spliced in and chewed by the simulation (so what gets written is the wrong
// shape). A static DBpedia response settles after one cycle and hides it
// completely. So the stub gains a row per cycle, which is just an endpoint
// that has gained a car.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const ROOT = path.resolve(__dirname, "..", "..");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

// The real harvest CSV is literally what the SPARQL query returns, so the
// merge runs against the same thing it does in the wild rather than a fixture
// shaped to pass.
const raw = fs.readFileSync(path.join(ROOT, "data_src/harvest/carweb_dbpedia_harvest.csv"), "utf-8").split("\n");
const a0 = raw.findIndex(l => l.startsWith("#===MAIN==="));
const b0 = raw.findIndex((l, i) => i > a0 && l.startsWith("#==="));
const MAIN = raw.slice(a0 + 1, b0).join("\n");

let CSV_NOW = MAIN;

// One page load, all the way through: data.js, the live layer's boot splice,
// app.js (the part that matters), boot(), then one forced refresh.
async function cycle(storage) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.getBoundingClientRect = () =>
    ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  for (const k in storage) window.localStorage.setItem(k, storage[k]);
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes("dbpedia.org/sparql")) return Promise.resolve({ ok: true, text: async () => CSV_NOW });
    return Promise.resolve({ ok: true, json: async () => ({ query: { categorymembers: [] } }) });
  };
  window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = window; global.document = window.document;
  const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  ev("d3.min.js"); ev("data.js");
  const baked = window.CARDATA.links.length;
  ev("llm_families_data.js");
  window.LLM_FAMILIES = window.LLM_FAMILIES || { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
  ev("llm_families.js");
  ev("data_live.js");                       // boot splice happens here
  const spliced = window.CARDATA.links.length - baked;
  ev("app.js"); ev("timeline.js"); ev("sixdeg.js");
  window.CarWeb.boot();                     // the simulation rewrites link endpoints
  await window.CarWebLive.refresh();
  await new Promise(r => setTimeout(r, 300));
  const out = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    out[k] = window.localStorage.getItem(k);
  }
  const rawDelta = out["carweb_live_snapshot_v1"];
  return {
    storage: out, spliced, bytes: rawDelta ? rawDelta.length : 0,
    delta: rawDelta ? JSON.parse(rawDelta) : null,
    toast: window.document.getElementById("livetoast-msg").textContent,
  };
}

(async () => {
  const runs = [];
  let store = {};
  for (let i = 1; i <= 4; i++) {
    // An endpoint that has gained one car since last time.
    CSV_NOW = MAIN + `\n"Probe_Car_${i}","2024","","Ford","","Ford_Mustang","",""`;
    const r = await cycle(store);
    runs.push(r);
    store = r.storage;
  }

  // ---------- the shape ----------
  // The one assertion that would have caught this three fixes ago.
  runs.forEach((r, i) => {
    const bad = (r.delta ? r.delta.newLinks : []).filter(l => l.source && typeof l.source === "object");
    check(`cycle ${i + 1}: every saved link names its endpoints by id, not by whole node`,
          bad.length === 0, bad.length + " of " + (r.delta ? r.delta.newLinks.length : 0));
  });
  runs.forEach((r, i) => {
    const simFields = (r.delta ? r.delta.newLinks.concat(r.delta.newNodes) : [])
      .filter(o => o && ("index" in o || "vx" in o || "sn" in o));
    check(`cycle ${i + 1}: the simulation's own bookkeeping is not saved with it`,
          simFields.length === 0, simFields.length + " entries carrying x/vx/index/sn");
  });

  // ---------- the consequence ----------
  // Cycle 1 has nothing cached, so it splices nothing; every cycle after it
  // must splice everything the one before saved.
  for (let i = 1; i < runs.length; i++) {
    const savedBefore = runs[i - 1].delta.newLinks.length;
    check(`cycle ${i + 1}: splices everything the previous cycle saved`,
          runs[i].spliced === savedBefore, runs[i].spliced + " of " + savedBefore);
  }
  runs.forEach((r, i) => {
    check(`cycle ${i + 1}: nothing is rediscovered, so Apply is sticking`,
          !/already saved from a previous one/.test(r.toast), r.toast.slice(0, 90));
  });

  // ---------- and it stays small ----------
  // 29KB -> 367KB -> 698KB was the old curve, on its way to the quota that
  // silently broke the save entirely.
  const grew = runs[runs.length - 1].bytes / runs[0].bytes;
  check("the saved delta stays proportional to what was found, not to how many "
        + "times you have refreshed", grew < 1.5,
        runs.map(r => Math.round(r.bytes / 1024) + "KB").join(" -> "));

  // ---------- a browser that already has a poisoned delta recovers ----------
  // Fixing the writer is not enough on its own: there are deltas in this shape
  // sitting in real browsers right now, and they should come good on the next
  // page load rather than needing another refresh first.
  {
    const good = JSON.parse(runs[runs.length - 1].storage["carweb_live_snapshot_v1"]);
    const poisoned = JSON.parse(JSON.stringify(good));
    poisoned.newLinks = poisoned.newLinks.map(l => ({
      // exactly what JSON.stringify produced from a d3-mutated link
      source: { id: l.source, type: "model", label: "x", x: 1, y: 2, vx: 0, vy: 0, index: 3 },
      target: { id: l.target, type: "model", label: "y", x: 4, y: 5, vx: 0, vy: 0, index: 6 },
      type: l.type,
    }));
    const before = poisoned.newLinks.length;
    // One more car than the poisoned delta knows about, so this round finds
    // something and therefore writes -- which is what proves the old shape is
    // converted on the way back out and not just tolerated on the way in.
    CSV_NOW = MAIN + '\n"Probe_Car_recover","2024","","Ford","","Ford_Mustang","",""';
    const r = await cycle({ "carweb_live_snapshot_v1": JSON.stringify(poisoned) });
    check("a delta left behind by an older build still splices, whole",
          r.spliced === before, r.spliced + " of " + before);
    check("...and is written back out in the right shape, so it heals itself",
          !!r.delta && r.delta.newLinks.length >= before &&
          r.delta.newLinks.every(l => typeof l.source === "string"),
          r.delta && r.delta.newLinks.filter(l => typeof l.source !== "string").length
            + " still wrong of " + (r.delta ? r.delta.newLinks.length : 0));
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
