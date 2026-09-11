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
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });

global.window = window; global.document = window.document;
function loadScript(f){ window.eval(fs.readFileSync(path.join(APP,f),"utf-8")); }
loadScript("d3.min.js"); loadScript("data.js");

const DATA = window.CARDATA;
const famNode = { id: "fam-test-x3", type: "family", label: "X3", make: "BMW", year: 2003, end: null,
  designers: [], engineers: [], generations: ["m-test-x3-bare", "m-test-x3-g01"] };
const bareGen = { id: "m-test-x3-bare", type: "model", label: "X3", make: "BMW", year: 2003, end: 2010,
  familyOf: "fam-test-x3", wp: "BMW X3", designers: [], engineers: [] };
const g01Gen = { id: "m-test-x3-g01", type: "model", label: "X3 (G01)", make: "BMW", year: 2017, end: null,
  familyOf: "fam-test-x3", wp: "BMW X3 (G01)", designers: ["Test Designer"], engineers: [] };
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "BMW");
if (!makeNode) { makeNode = { id: "mk-bmw-test", type: "make", label: "BMW", year: 1916 }; DATA.nodes.push(makeNode); }
DATA.nodes.push(famNode, bareGen, g01Gen);
DATA.links.push({ source: "fam-test-x3", target: makeNode.id, type: "made" });
DATA.links.push({ source: "fam-test-x3", target: "m-test-x3-bare", type: "generation" });
DATA.links.push({ source: "fam-test-x3", target: "m-test-x3-g01", type: "generation" });
DATA.links.push({ source: "m-test-x3-bare", target: "m-test-x3-g01", type: "gensucc" });

const seeded = {
  families: {},
  relations: {},
  recheck: {
    "fam-test-x3": {
      status: "provisional",
      checkedAt: new Date().toISOString(),
      sourceTitle: "BMW X3",
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "G01", yearStart: 2017, yearEnd: null, designers: ["Test Designer"], engineers: [] },
        ],
      },
      discrepancy: "an existing generation here is really just the bare nameplate itself",
      attempts: 1,
      feedback: [],
    },
  },
};
window.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { this.status = 200; this.responseText = JSON.stringify(seeded); };
};

(function () {
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = xhr.status === 200 ? JSON.parse(xhr.responseText) : { families: {} };
  data.__serverAvailable = xhr.status === 200;
  window.LLM_FAMILIES = data;
})();
loadScript("llm_families.js"); loadScript("app.js"); loadScript("timeline.js"); loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setLlmCheck(true);
const fam = cw.byId.get("fam-test-x3");
console.log("serverAvailable:", window.LlmFamilies.serverAvailable);
console.log("BEFORE generations:", fam.generations);

cw.openDetail(fam);
const label = window.document.querySelector(".dt-llmcheck .llm-label");
console.log("discrepancy label found:", !!label, label && label.textContent);
const yesBtn = window.document.querySelector(".dt-llmcheck .llm-yes");
console.log("yes button found:", !!yesBtn);
if (yesBtn) yesBtn.onclick();

console.log("AFTER generations:", fam.generations);
console.log("bare node retired?", cw.byId.get("m-test-x3-bare").retired);
console.log("recheck entry status after apply:", window.LlmFamilies.recheckEntryFor(fam.id).status);
console.log("dt-generations innerHTML:", window.document.querySelector(".dt-generations").innerHTML.replace(/\s+/g," ").slice(0,400));
console.log("dt-llmcheck innerHTML after apply:", window.document.querySelector(".dt-llmcheck").innerHTML);
process.exit(0);
