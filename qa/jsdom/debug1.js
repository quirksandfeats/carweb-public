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
window.fetch = () => Promise.resolve({ok:true, json: async () => ({ok:true})});
window.XMLHttpRequest = function(){ this.open=()=>{}; this.send=()=>{throw new Error("no server");}; };
global.window = window; global.document = window.document;
function loadScript(f){ window.eval(fs.readFileSync(path.join(APP,f),"utf-8")); }
loadScript("d3.min.js"); loadScript("data.js");
window.LLM_FAMILIES = {families:{},relations:{},__serverAvailable:true};
loadScript("llm_families.js"); loadScript("app.js"); loadScript("timeline.js"); loadScript("sixdeg.js");
window.CarWeb.boot();
const cw = window.CarWeb;
const p911 = cw.byId.get("fam-porsche-911");
cw.adj.get(p911.id).forEach(({n:o,l}) => {
  if (l.type==="platform"||l.type==="related"||l.type==="succession") console.log(l.type, o.type, o.id, o.label, "gens="+((o.generations||[]).length));
});
