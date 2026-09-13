// Real user request: "the user should be able to request a scan after they
// have focused on a particular model or nameplate in the graph. If the user
// clicks 'request scan' then the user should be prompted to select a
// particular car on the graph, or search the name and model of the car."
//
// So a request names ONE CAR, and the panel's job is to make picking it
// obvious: prefilled from whatever the user is already looking at, searchable
// otherwise, and retargeting itself if they click a different car while it is
// open. Nothing can be sent without a car.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

const posted = [];
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
const cancelled = [];
let serverQueue = [];
window.fetch = (url, opts) => {
  if (String(url).includes("/api/request/queue")) {
    posted.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, already: false, queue: serverQueue, last: null }) });
  }
  if (String(url).includes("/api/request/cancel")) {
    cancelled.push(JSON.parse(opts.body));
    serverQueue = serverQueue.filter(j => j.id !== JSON.parse(opts.body).id);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, removed: 1, queue: serverQueue, last: null }) });
  }
  if (String(url).includes("/api/request/status")) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, queue: serverQueue, last: null }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
};
// No serve.py: exactly the case the button exists for.
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;

function seed(DATA) {
  DATA.nodes.push({ id: "mk-testreq", type: "make", label: "TestReq", year: 1950 });
  DATA.nodes.push({ id: "m-testreq-alpha", type: "model", label: "Alpha", make: "TestReq", year: 1970, end: 1980, designers: [], engineers: [] });
  DATA.nodes.push({ id: "m-testreq-beta", type: "model", label: "Beta", make: "TestReq", year: 1985, end: 1995, designers: [], engineers: [] });
  DATA.nodes.push({ id: "p-testreq-person", type: "person", kind: "person", label: "Alpha Person", roles: ["designer"], born: 1930, died: null, country: null, wp: null });
  DATA.links.push({ source: "m-testreq-alpha", target: "mk-testreq", type: "made" });
  DATA.links.push({ source: "m-testreq-beta", target: "mk-testreq", type: "made" });
}

const loadScript = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
loadScript("d3.min.js");
loadScript("data.js");
seed(window.CARDATA);
window.LLM_FAMILIES = { families: {}, relations: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

const cw = window.CarWeb;
cw.boot();
const $ = id => window.document.getElementById(id);
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  t("the button is shown when there is no local server", $("llmrequest-wrap").hidden === false);
  t("the Tools menu is hidden in that same case -- they are mirrors",
    $("toolsmenu-wrap").hidden === true);

  // ---- prefilled from the open card -------------------------------------
  cw.openDetail(cw.byId.get("m-testreq-alpha"));
  $("llmrequest-btn").click();
  await wait(100);
  t("opening the panel prefills the car whose card is open",
    /Alpha/.test($("llmrequest-chosen").textContent) && !$("llmrequest-chosen").hidden,
    $("llmrequest-chosen").textContent);
  t("...and the send button is ready rather than telling you to pick one",
    $("llmrequest-send").textContent === "Send request" && !$("llmrequest-send").disabled);

  // ---- clicking a different car while it is open retargets ---------------
  cw.openDetail(cw.byId.get("m-testreq-beta"));
  await wait(50);
  t("clicking another car while the panel is open retargets the request",
    /Beta/.test($("llmrequest-chosen").textContent), $("llmrequest-chosen").textContent);

  // ---- a person is not a scannable target -------------------------------
  cw.openDetail(cw.byId.get("p-testreq-person"));
  await wait(50);
  t("opening a designer does not retarget it -- a person has nothing to scan",
    /Beta/.test($("llmrequest-chosen").textContent), $("llmrequest-chosen").textContent);

  // ---- searching -------------------------------------------------------
  $("llmrequest-chosen").querySelector("button").click();   // clear
  await wait(30);
  t("clearing leaves nothing chosen and says so on the button",
    $("llmrequest-chosen").hidden && $("llmrequest-send").disabled &&
    $("llmrequest-send").textContent === "Pick a car first",
    $("llmrequest-send").textContent);

  const car = $("llmrequest-car");
  car.value = "alph";
  car.dispatchEvent(new window.Event("input"));
  await wait(50);
  const hits = [...$("llmrequest-carresults").querySelectorAll(".lrq-result")].map(b => b.textContent);
  t("typing searches the graph", hits.length >= 1 && /Alpha/.test(hits.join("|")), JSON.stringify(hits));
  t("...and does not offer people, only cars", !hits.some(h => /Person/.test(h)), JSON.stringify(hits));

  // Pick by name, not by position: the real graph has plenty of cars whose
  // names start with "Alpha" and ranks them by degree, so the seeded test car
  // is not first and should not be assumed to be.
  const mine = [...$("llmrequest-carresults").querySelectorAll(".lrq-result")]
    .find(b => /TestReq Alpha/.test(b.textContent));
  t("the seeded car is among the results", !!mine);
  mine.click();
  await wait(30);
  t("picking a result chooses it", /TestReq Alpha/.test($("llmrequest-chosen").textContent),
    $("llmrequest-chosen").textContent);
  t("...and closes the result list", $("llmrequest-carresults").hidden);

  // ---- sending ---------------------------------------------------------
  $("llmrequest-send").click();
  await wait(60);
  t("nothing is sent without a passphrase", posted.length === 0,
    $("llmrequest-status").textContent);
  t("...and it says which field is missing", /passphrase/i.test($("llmrequest-status").textContent),
    $("llmrequest-status").textContent);

  $("llmrequest-pass").value = "a-passphrase";
  $("llmrequest-note").value = "the 1930 entry looks wrong";
  $("llmrequest-send").click();
  await wait(120);
  t("the request carries the car's id", posted.length === 1 && posted[0].targetId === "m-testreq-alpha",
    JSON.stringify(posted));
  t("...and a readable label, so the queue can be shown without the graph",
    posted[0].targetLabel === "TestReq Alpha", posted[0].targetLabel);
  t("...and the note", posted[0].note === "the 1930 entry looks wrong");
  t("the passphrase is cleared after sending", $("llmrequest-pass").value === "");

  // ---- the queue is shown, and a request can be taken back out ----------
  serverQueue = [
    { id: "j1", state: "running", queuedAt: new Date().toISOString(), targetId: "m-x", targetLabel: "Car X" },
    { id: "j2", state: "queued", queuedAt: new Date().toISOString(), targetId: "m-y", targetLabel: "Car Y" },
  ];
  $("llmrequest-btn").click();           // close
  $("llmrequest-btn").click();           // reopen -> refresh
  await wait(120);
  const qText = $("llmrequest-queue").textContent;
  t("the panel lists what is waiting, by car name",
    /Car X/.test(qText) && /Car Y/.test(qText), qText);
  t("...and marks the one being scanned", /running now/.test(qText), qText);

  const drops = [...$("llmrequest-queue").querySelectorAll(".lrq-drop")];
  t("only the ones NOT running offer a remove button -- the running one's "
    + "result would have nowhere to land", drops.length === 1 && drops[0].dataset.id === "j2",
    drops.map(b => b.dataset.id).join(","));

  drops[0].click();
  await wait(60);
  t("removing without a passphrase asks for one first", cancelled.length === 0,
    $("llmrequest-status").textContent);

  $("llmrequest-pass").value = "a-passphrase";
  [...$("llmrequest-queue").querySelectorAll(".lrq-drop")][0].click();
  await wait(120);
  t("with the passphrase it withdraws that request",
    cancelled.length === 1 && cancelled[0].id === "j2", JSON.stringify(cancelled));
  t("...and the list updates without a reload",
    !/Car Y/.test($("llmrequest-queue").textContent), $("llmrequest-queue").textContent);

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
