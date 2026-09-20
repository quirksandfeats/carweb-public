const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
function fakeCtx(){const noop=()=>{};const h={measureText:()=>({width:10})};return new Proxy(h,{get(t,k){return k in t?t[k]:noop},set(){return true}});}
// Exactly what the agent opens.
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html?agent=1", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
window.requestAnimationFrame = () => 1; window.devicePixelRatio = 1;
window.matchMedia = q => ({matches:false, media:q, addEventListener(){}, removeEventListener(){}});
window.Element.prototype.getBoundingClientRect = () => ({width:1200,height:800,top:0,left:0,right:1200,bottom:800,x:0,y:0});
Object.defineProperty(window.HTMLElement.prototype,"offsetHeight",{get(){return 40}});
Object.defineProperty(window.HTMLElement.prototype,"offsetParent",{get(){return window.document.body}});
window.fetch = (u,o) => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function(){this.open=()=>{};this.send=()=>{throw new Error("no server")};};
global.window = window; global.document = window.document;
const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
load("d3.min.js"); load("data.js");
// serve.py IS answering for the agent, so the store is the real one.
window.LLM_FAMILIES = Object.assign(
  JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8")),
  { __serverAvailable: true });
load("llm_families.js"); load("app.js"); load("timeline.js"); load("sixdeg.js");
const cw = window.CarWeb, LF = window.LlmFamilies;
let bootErr = null;
try { cw.boot(); } catch (e) { bootErr = e; }
console.log("boot error:", bootErr ? bootErr.stack.split("\n").slice(0,3).join(" | ") : "(none)");
console.log("allEntries:", (LF.allEntries && LF.allEntries().length), "recheck:", (LF.allRecheckEntries && LF.allRecheckEntries().length));
console.log("serverAvailable:", LF.serverAvailable, "| decisionSource:", LF.decisionSource());
for (const id of ["m-mercedes-benz-e-class", "m-chevrolet-suburban"]) {
  const n = cw.byId.get(id);
  console.log("\nid:", id, "->", n ? [n.type, n.make, n.label, "retired=" + !!n.retired,
    "familyOf=" + n.familyOf, "gens=" + ((n.generations||[]).length)].join(" | ") : "(NOT IN byId)");
  if (!n) continue;
  const spec = cw.llmJobSpecFor ? cw.llmJobSpecFor(n) : "(no llmJobSpecFor)";
  console.log("   llmJobSpecFor:", JSON.stringify(spec));
  const j = cw.requestScan ? cw.requestScan(n) : "(no requestScan)";
  console.log("   requestScan  :", JSON.stringify(j));
}
console.log("\njobsStarted:", LF.jobsStarted && LF.jobsStarted(), "| queue:", JSON.stringify(LF.jobs().map(x => x.kind + ":" + x.targetId + ":" + x.state)));
