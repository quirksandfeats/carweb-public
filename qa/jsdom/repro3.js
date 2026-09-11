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
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
global.window = window; global.document = window.document;
function loadScript(f){ window.eval(fs.readFileSync(path.join(APP,f),"utf-8")); }
loadScript("d3.min.js"); loadScript("data.js");

// A plain (non-family) model as the "B" side -- mirrors feature 1's new
// family<->model disambiguation path.
const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "Toyota");
if (!makeNode) { makeNode = { id: "mk-toyota-test", type: "make", label: "Toyota", year: 1937 }; DATA.nodes.push(makeNode); }
const famA = { id: "fam-test-86", type: "family", label: "86", make: "Toyota", year: 2012, end: null,
  designers: [], engineers: [], generations: ["m-test-86-zn6", "m-test-86-zn8"] };
const g1 = { id: "m-test-86-zn6", type: "model", label: "86 (ZN6)", make: "Toyota", year: 2012, end: 2021, familyOf: "fam-test-86" };
const g2 = { id: "m-test-86-zn8", type: "model", label: "86 (ZN8)", make: "Toyota", year: 2021, end: null, familyOf: "fam-test-86" };
const modelB = { id: "m-test-gr86-sibling", type: "model", label: "Test Sibling Model", make: "Subaru", year: 2012, end: null };
let subaru = DATA.nodes.find(n => n.type === "make" && n.label === "Subaru");
if (!subaru) { subaru = { id: "mk-subaru-test", type: "make", label: "Subaru", year: 1953 }; DATA.nodes.push(subaru); }
DATA.nodes.push(famA, g1, g2, modelB);
DATA.links.push({ source: "fam-test-86", target: makeNode.id, type: "made" });
DATA.links.push({ source: "fam-test-86", target: "m-test-86-zn6", type: "generation" });
DATA.links.push({ source: "fam-test-86", target: "m-test-86-zn8", type: "generation" });
DATA.links.push({ source: "m-test-86-zn6", target: "m-test-86-zn8", type: "gensucc" });
DATA.links.push({ source: "m-test-gr86-sibling", target: subaru.id, type: "made" });
DATA.links.push({ source: "fam-test-86", target: "m-test-gr86-sibling", type: "platform" }); // the coarse fact to disambiguate

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js"); loadScript("app.js"); loadScript("timeline.js"); loadScript("sixdeg.js");

window.fetch = (url, opts) => {
  if (url === "/api/ollama/chat") {
    const body = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ message: { content: JSON.stringify(
      { resolved: true, codeA: "86 (ZN6)", codeB: "Test Sibling Model", reason: "years overlap" }
    ) } }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setLlmCheck(true);
const famA_ = cw.byId.get("fam-test-86");
const linksBefore = cw.links.length;

cw.openDetail(famA_);
setTimeout(() => {
  const label = window.document.querySelector(".dt-relations .llm-label");
  console.log("provisional label:", !!label, label && label.textContent);
  const yesBtn = window.document.querySelector(".dt-relations .llm-rel-yes");
  console.log("yes button found:", !!yesBtn);
  if (yesBtn) yesBtn.onclick();
  console.log("links before/after:", linksBefore, cw.links.length);
  const resolved = cw.links.find(l => l.type === "platform" && l.llmResolved);
  console.log("resolved link:", resolved && (resolved.source + " -> " + resolved.target));
  console.log("dt-relations innerHTML after apply:", window.document.querySelector(".dt-relations").innerHTML);
  process.exit(0);
}, 50);
