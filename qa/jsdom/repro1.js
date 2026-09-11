const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const APP = path.resolve("/sessions/gracious-zen-galileo/mnt/carweb/app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({width:1000,height:800,top:0,left:0,right:1000,bottom:800,x:0,y:0});
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

let persisted = null;
window.fetch = (url, opts) => {
  if (url === "/api/ollama/chat") {
    const body = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ message: { content: JSON.stringify(window.__stubAnswer(body)) } }) });
  }
  if (url === "/api/llm-families") {
    persisted = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function(){ this.open=()=>{}; this.send=()=>{throw new Error("no server");}; };
global.window = window; global.document = window.document;
function loadScript(f){ window.eval(fs.readFileSync(path.join(APP,f),"utf-8")); }
loadScript("d3.min.js"); loadScript("data.js");

// Build a fake "build-time family" scenario mimicking the BMW X3 bug: a bare
// "X3" node listed as one of its own family's generations, alongside a real
// generation X3 (G01).
const DATA = window.CARDATA;
const famNode = { id: "fam-test-x3", type: "family", label: "X3", make: "BMW", year: 2003, end: null,
  designers: [], engineers: [], generations: ["m-test-x3-bare", "m-test-x3-g01"] };
const bareGen = { id: "m-test-x3-bare", type: "model", label: "X3", make: "BMW", year: 2003, end: 2010,
  familyOf: "fam-test-x3", wp: "BMW X3", designers: [], engineers: [] };
const g01Gen = { id: "m-test-x3-g01", type: "model", label: "X3 (G01)", make: "BMW", year: 2017, end: null,
  familyOf: "fam-test-x3", wp: "BMW X3 (G01)", designers: ["Test Designer"], engineers: [] };
const makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "BMW") || { id: "mk-bmw-test", type: "make", label: "BMW", year: 1916 };
if (!DATA.nodes.includes(makeNode)) DATA.nodes.push(makeNode);
DATA.nodes.push(famNode, bareGen, g01Gen);
DATA.links.push({ source: "fam-test-x3", target: makeNode.id, type: "made" });
DATA.links.push({ source: "fam-test-x3", target: "m-test-x3-bare", type: "generation" });
DATA.links.push({ source: "fam-test-x3", target: "m-test-x3-g01", type: "generation" });
DATA.links.push({ source: "m-test-x3-bare", target: "m-test-x3-g01", type: "gensucc" });

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js"); loadScript("app.js"); loadScript("timeline.js"); loadScript("sixdeg.js");

window.__stubAnswer = (body) => {
  // fresh cross-check answer: only the real G01 generation, correctly
  // omitting the bogus bare "X3" entry.
  return { hasMultipleGenerations: true, generations: [
    { code: "G01", yearStart: 2017, yearEnd: null, designers: ["Test Designer"], engineers: [], sharedPlatform: null },
  ] };
};

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setLlmCheck(true);
const fam = cw.byId.get("fam-test-x3");
console.log("BEFORE generations:", fam.generations);

cw.openDetail(fam);
setTimeout(() => {
  const status = window.document.querySelector(".dt-llmcheck .llm-status");
  console.log("status after checkFamily:", status && status.textContent);
  const entry = window.LlmFamilies.recheckEntryFor(fam.id);
  console.log("recheck entry status:", entry && entry.status, "discrepancy:", entry && entry.discrepancy);

  const yesBtn = window.document.querySelector(".dt-llmcheck .llm-yes");
  console.log("yes button found:", !!yesBtn);
  if (yesBtn) yesBtn.onclick();

  console.log("AFTER generations:", fam.generations);
  console.log("bare node retired?", cw.byId.get("m-test-x3-bare").retired);
  console.log("recheck entry status after apply:", window.LlmFamilies.recheckEntryFor(fam.id).status);
  console.log("dt-llmcheck innerHTML after apply:", window.document.querySelector(".dt-llmcheck").innerHTML);
  console.log("persisted to disk:", JSON.stringify(persisted && persisted.recheck));
  process.exit(0);
}, 50);
