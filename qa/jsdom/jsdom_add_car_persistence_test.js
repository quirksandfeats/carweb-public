// Real user report: "The added new car doesn't seem to appear on the
// knowledge graph, neither when I click on the manufacturer nor when I
// search up the car that I entered." Root cause: app.js's mintAndOpen (Add
// Car panel) only ever spliced the new make/model node into the CURRENT
// tab's in-memory nodes/links/byId/adj -- nothing about a manually-typed car
// was ever recorded anywhere a later page boot (which rebuilds nodes/links
// from scratch off cars.json/data.js every single time) could see it, so it
// vanished completely on the next reload or in any other tab. Fixed via a
// new llm_families.js `userCars` store entry (registerUserCar, written the
// moment a car is actually minted) replayed by a new `applyUserCars(nodes,
// links)`, called first in app.js's boot sequence, before applyConfirmed.
//
// This test proves the FULL round trip a real reload does: mint a car in a
// first "session" (capturing what actually gets POSTed to
// /api/llm-families), then boot a completely SEPARATE, fresh JSDOM instance
// seeded with exactly that persisted data -- simulating the user closing and
// reopening the tab -- and confirms the car is now findable both via the
// make's own adjacency (what a "click the manufacturer" interaction walks)
// and via the live search index.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
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
function newWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  window.requestAnimationFrame = () => 1;
  window.devicePixelRatio = 1;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  return window;
}
function loadScript(window, f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }

const WIKITEXT_SINGLE = "{{Infobox automobile|name=Test Car}}\nJust a plain car with nothing distinguishing about it.\n";
const REAL_TITLE = "TestPersistMake Vandroshka2";

// ---------- "session 1": mint the car, capture what gets persisted ----------
let persistedBody = null;
const w1 = newWindow();
w1.fetch = (url, opts) => {
  const u = String(url);
  if (u.includes("action=parse")) {
    const m = u.match(/page=([^&]+)/);
    const title = decodeURIComponent(m[1]);
    if (title === REAL_TITLE) return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": WIKITEXT_SINGLE } } }) });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  if (u.includes("action=query") && u.includes("list=search")) return Promise.resolve({ ok: true, json: async () => ({ query: { search: [] } }) });
  if (u === "/api/llm/chat") {
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hasMultipleGenerations: false, generations: [] }) } }] }) });
  }
  if (u === "/api/llm-families" && opts && opts.method === "POST") {
    persistedBody = JSON.parse(opts.body); // this is exactly what a real serve.py would write to disk
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
w1.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { this.status = 200; this.responseText = JSON.stringify({ families: {}, relations: {}, recheck: {}, __serverAvailable: true }); };
};
global.window = w1; global.document = w1.document;
loadScript(w1, "d3.min.js");
loadScript(w1, "data.js");
(function () {
  const xhr = new w1.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = JSON.parse(xhr.responseText);
  data.__serverAvailable = true;
  w1.LLM_FAMILIES = data;
})();
loadScript(w1, "llm_families.js");
loadScript(w1, "app.js");
loadScript(w1, "timeline.js");
loadScript(w1, "sixdeg.js");
w1.CarWeb.boot();

const btn1 = w1.document.getElementById("addcarbtn");
btn1.onclick();
w1.document.getElementById("addcar-make").value = "TestPersistMake";
w1.document.getElementById("addcar-model").value = "Vandroshka2";
w1.document.getElementById("addcar-submit").onclick();

setTimeout(() => {
  const mintedId = "usercar-testpersistmake-vandroshka2";
  const mintedLive = w1.CarWeb.byId.get(mintedId);
  check("session 1: the car was minted live in this tab, same as before", !!mintedLive, mintedLive && mintedLive.id);
  check("registerUserCar actually persisted something to /api/llm-families", !!persistedBody, persistedBody);
  check("the persisted body carries a userCars entry for this exact node id",
    !!(persistedBody && persistedBody.userCars && persistedBody.userCars[mintedId]), persistedBody && persistedBody.userCars);
  const rec = persistedBody && persistedBody.userCars && persistedBody.userCars[mintedId];
  check("the persisted entry carries the make/model text and resolved Wikipedia title needed to replay it",
    rec && rec.makeLabel === "TestPersistMake" && rec.modelLabel === "Vandroshka2" && rec.wpTitle === REAL_TITLE, rec);

  // ---------- "session 2": a completely fresh tab/reload, seeded with EXACTLY what session 1 persisted ----------
  const w2 = newWindow();
  w2.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  w2.XMLHttpRequest = function () {
    this.open = () => {};
    this.send = () => { this.status = 200; this.responseText = JSON.stringify(persistedBody); };
  };
  global.window = w2; global.document = w2.document;
  loadScript(w2, "d3.min.js");
  loadScript(w2, "data.js");
  (function () {
    const xhr = new w2.XMLHttpRequest();
    xhr.open("GET", "/api/llm-families", false);
    xhr.send(null);
    const data = JSON.parse(xhr.responseText);
    data.__serverAvailable = true;
    w2.LLM_FAMILIES = data;
  })();
  loadScript(w2, "llm_families.js");
  loadScript(w2, "app.js");
  loadScript(w2, "timeline.js");
  loadScript(w2, "sixdeg.js");
  w2.CarWeb.boot();

  const cw2 = w2.CarWeb;
  const revived = cw2.byId.get(mintedId);
  check("session 2 (fresh boot): the manually-added car exists again after a full reload, not just in the original tab",
    !!revived, revived);
  check("session 2: it kept its make/model label and resolved Wikipedia title",
    revived && revived.label === "Vandroshka2" && revived.make === "TestPersistMake" && revived.wp === REAL_TITLE, revived);

  const revivedMake = cw2.nodes.find(n => n.type === "make" && n.label === "TestPersistMake");
  check("session 2: its make node also exists again", !!revivedMake, revivedMake && revivedMake.id);
  // d3's forceLink (wired up inside buildSim, which boot() already ran)
  // resolves link.source/target from plain string ids into actual node
  // object references as soon as the simulation is created -- compare via
  // .id (or .sn/.tn, same thing) rather than the original string form.
  const madeLink = cw2.links.find(l => l.type === "made" &&
    (l.source && l.source.id) === revivedMake.id && (l.target && l.target.id) === mintedId);
  check("session 2: the make<->model 'made' link exists again -- this is exactly what clicking the manufacturer walks",
    !!madeLink, madeLink);
  const adjFromMake = cw2.adj.get(revivedMake.id) || [];
  check("session 2: the model is reachable via the make's own adjacency (clicking the manufacturer would reveal it)",
    adjFromMake.some(a => a.n && a.n.id === mintedId), adjFromMake.map(a => a.n && a.n.id));

  const found = cw2.searchAll("Vandroshka2");
  check("session 2: searching for the car's model name finds it", found.some(n => n.id === mintedId), found.map(n => n.id));
  const foundByMake = cw2.searchAll("TestPersistMake");
  check("session 2: searching for the car's make name finds it too", foundByMake.some(n => n.id === mintedId), foundByMake.map(n => n.id));

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}, 80);
