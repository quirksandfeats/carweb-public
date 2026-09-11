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
global.window = window; global.document = window.document;
function loadScript(f){ window.eval(fs.readFileSync(path.join(APP,f),"utf-8")); }
loadScript("d3.min.js"); loadScript("data.js");

const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMake");
if (!makeNode) { makeNode = { id: "mk-testmake", type: "make", label: "TestMake", year: 1960 }; DATA.nodes.push(makeNode); }
// A plain, ungrouped model that will become a family once the LLM finds
// generations -- and ALREADY has a coarse "platform" link to another plain
// model, exactly like a build-time harvested fact would.
const plainModel = { id: "m-test-nameplate", type: "model", label: "Nameplate", make: "TestMake", year: 1990, end: null, wp: "Test Nameplate" };
const otherModel = { id: "m-test-sibling", type: "model", label: "Sibling", make: "TestMake", year: 1990, end: null };
DATA.nodes.push(plainModel, otherModel);
DATA.links.push({ source: "m-test-nameplate", target: makeNode.id, type: "made" });
DATA.links.push({ source: "m-test-sibling", target: makeNode.id, type: "made" });
DATA.links.push({ source: "m-test-nameplate", target: "m-test-sibling", type: "platform" });

const seeded = {
  families: {
    "m-test-nameplate": {
      status: "provisional",
      checkedAt: new Date().toISOString(),
      sourceTitle: "Test Nameplate",
      proposal: { hasMultipleGenerations: true, generations: [
        { code: "Gen1", yearStart: 1990, yearEnd: 2000, designers: [], engineers: [] },
        { code: "Gen2", yearStart: 2000, yearEnd: null, designers: [], engineers: [] },
      ] },
      attempts: 1, feedback: [],
    },
  },
  relations: {}, recheck: {},
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { this.status = 200; this.responseText = JSON.stringify(seeded); }; };
(function () {
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = xhr.status === 200 ? JSON.parse(xhr.responseText) : { families: {} };
  data.__serverAvailable = xhr.status === 200;
  window.LLM_FAMILIES = data;
})();
loadScript("llm_families.js"); loadScript("app.js"); loadScript("timeline.js"); loadScript("sixdeg.js");

window.fetch = (url, opts) => {
  if (url === "/api/ollama/chat") {
    return Promise.resolve({ ok: true, json: async () => ({ message: { content: JSON.stringify(
      { resolved: true, codeA: "Nameplate Gen1", codeB: "Sibling", reason: "years line up" }
    ) } }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setLlmCheck(true);
const before = cw.byId.get("m-test-nameplate");
console.log("starts as:", before.type);

cw.openDetail(before);
const yesBtn = window.document.querySelector(".llm-yes");
console.log("split Yes button found:", !!yesBtn);
yesBtn.onclick(); // confirm the generation split -- applyLlmConfirm runs, ends with openDetail(n) again

console.log("now type:", before.type, "generations:", before.generations);
// Immediately, same panel, no reopen -- does the relation-check UI show up?
const relStatus = window.document.querySelector(".dt-relations .llm-status");
console.log("relation-check status visible immediately after split:", !!relStatus, relStatus && relStatus.textContent);

setTimeout(() => {
  const relLabel = window.document.querySelector(".dt-relations .llm-label");
  console.log("relation provisional label:", !!relLabel, relLabel && relLabel.textContent);
  const relYes = window.document.querySelector(".dt-relations .llm-rel-yes");
  console.log("relation Yes button found:", !!relYes);
  const linksBefore = cw.links.length;
  if (relYes) relYes.onclick();
  console.log("links before/after relation confirm:", linksBefore, cw.links.length);
  const resolved = cw.links.find(l => l.type === "platform" && l.llmResolved);
  console.log("resolved link:", resolved && (resolved.source + " -> " + resolved.target));
  console.log("dt-relations content after confirm:", window.document.querySelector(".dt-relations").innerHTML);
  process.exit(0);
}, 60);
