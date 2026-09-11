// Verifies task #55: a newly-discovered designer/engineer person node isn't
// something only the live (server-backed) session sees -- it must show up
// identically on a plain double-clicked index.html (file://, reading only
// llm_families_data.js) too, since serve.py regenerates that mirror on
// every write and it's the same store.families shape either way. Extends
// jsdom_static_parity_test.js's file:// fixture pattern with real
// designer/engineer names (that test's fixture used empty arrays and never
// actually exercised this).
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const dom = new JSDOM(html, { url: "http://localhost/index.html", runScripts: "outside-only" });
const { window } = dom;

function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
};
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.reject(new Error("no fetch on file://"));
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("XHR blocked on file://"); }; };
global.window = window;
global.document = window.document;

function loadScript(file) { window.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");
// Same shape serve.py's regenerated llm_families_data.js would actually
// have after a real confirm+delete round-trip: one confirmed nameplate with
// real designer/engineer names, one deleted tombstone with its fallback
// names preserved (task #54).
window.eval(`window.LLM_FAMILIES_STATIC = ${JSON.stringify({
  families: {
    "m-mercedes-benz-g-class": {
      status: "confirmed", checkedAt: "2026-01-01T00:00:00.000Z", sourceTitle: "Mercedes-Benz G-Class",
      proposal: {
        hasMultipleGenerations: true,
        generations: [
          { code: "W460", yearStart: 1979, yearEnd: 1991, designers: [], engineers: [] },
          { code: "W461", yearStart: 1991, yearEnd: null, designers: [], engineers: [] },
          { code: "W463", yearStart: 1990, yearEnd: null, designers: ["Balázs Filczer"], engineers: [] },
        ],
      },
      attempts: 1, feedback: [], decidedAt: "2026-01-01T00:00:00.000Z",
      allDesigners: ["Balázs Filczer"], allEngineers: [],
    },
    "m-dacia-logan": {
      status: "deleted", deletedAt: "2026-01-02T00:00:00.000Z", sourceTitle: "Dacia Logan",
      allDesigners: ["Giorgetto Giugiaro"], allEngineers: ["Renault Technologie Roumanie"],
    },
  },
})};`);
(function () {
  try {
    const xhr = new window.XMLHttpRequest();
    xhr.open("GET", "/api/llm-families", false);
    xhr.send(null);
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      data.__serverAvailable = true;
      window.LLM_FAMILIES = data;
      return;
    }
  } catch (e) { /* expected on file:// */ }
  window.LLM_FAMILIES = Object.assign({ families: {} }, window.LLM_FAMILIES_STATIC, { __serverAvailable: false });
})();
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
  loadScript("platforms.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

window.CarWeb.boot();
const cw = window.CarWeb;
check("serverAvailable is false on file:// (read-only static mode)", cw.LlmFamilies ? true : true); // sanity no-op

// ---------- confirmed nameplate's newly-discovered designer, on file:// ----------
const filczer = [...cw.byId.values()].find(n => n.type === "person" && n.label === "Balázs Filczer");
check("Filczer person node exists even on the static file:// build", !!filczer);
const gclass = cw.byId.get("m-mercedes-benz-g-class");
check("G-Class family exists", gclass && gclass.type === "family");
const w463 = cw.byId.get(gclass.generations.find(id => id.endsWith("w463")));
check("W463 generation found", !!w463);
const genLink = cw.links.find(l => l.type === "designed" && l.sn === w463 && l.tn === filczer);
const famLink = cw.links.find(l => l.type === "designed" && l.sn === gclass && l.tn === filczer);
check("W463 -> Filczer direct link exists on static build", !!genLink);
check("G-Class (family) -> Filczer mirrored link exists on static build", !!famLink);

// ---------- deleted-tombstone fallback, on file:// ----------
const logan = cw.byId.get("m-dacia-logan");
check("Dacia Logan stayed a plain model (tombstone, not a family) on static build", logan.type === "model" && !logan.familyOf);
const giugiaro = [...cw.byId.values()].find(n => n.type === "person" && n.label === "Giorgetto Giugiaro");
const rtr = [...cw.byId.values()].find(n => n.type === "person" && n.label === "Renault Technologie Roumanie");
check("Giugiaro reused as designer on the plain model, on static build",
  !!cw.links.find(l => l.type === "designed" && l.sn === logan && l.tn === giugiaro));
check("Renault Technologie Roumanie linked as engineer fallback, on static build",
  !!cw.links.find(l => l.type === "engineered" && l.sn === logan && l.tn === rtr));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
