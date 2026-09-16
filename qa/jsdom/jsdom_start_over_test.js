// Real user request: "Add this as an option in the delete/restore button area.
// Actually, add two buttons, one that wipes all the LLM stuff (links, nodes,
// etc everything done by the llm), and a third button which wipes everything
// and starts from scratch (no LLM stuff done, and the full graph rebuilt from
// dbpedia)."
//
// Both are destructive and one of them runs for minutes, so what this checks
// is mostly the safety around them: nothing fires on a single click, only one
// of the two can be armed at a time, the overlay reset goes through the
// endpoint that backs it up rather than the page emptying the store itself,
// and "start from scratch" really is both halves in order -- reset, then
// rebuild -- rather than a button that only does the loud half.
const { JSDOM, VirtualConsole } = require("jsdom");
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

// jsdom's window.location.reload is unforgeable -- it cannot be shadowed or
// replaced -- so a reload is observed the only way it can be: jsdom reports
// the attempted navigation as a jsdomError, which is counted here.
let reloaded = 0;
const vc = new VirtualConsole();
vc.on("jsdomError", e => { if (/navigation/i.test(String(e && e.message))) reloaded++; });
vc.on("error", () => {});
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html",
                              runScripts: "outside-only", virtualConsole: vc });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });

// Every call the panel can make, recorded. A reload is what both buttons end
// with, so it is captured rather than performed.
const calls = [];
let rebuildState = { ok: true, running: false, scriptExists: true, step: "", elapsed: 1, log: [] };
window.fetch = (url, opts) => {
  const u = String(url);
  calls.push((opts && opts.method === "POST" ? "POST " : "GET ") + u);
  if (u === "/api/llm-reset") {
    return Promise.resolve({ ok: true, status: 200, json: async () =>
      ({ ok: true, cleared: { relations: 834, families: 154, purged: 17 },
         backup: "/x/llm_layer_backups/llm_families-20260916-000000.json" }) });
  }
  if (u === "/api/rebuild") {
    if (opts && opts.method === "POST") {
      rebuildState = Object.assign({}, rebuildState, { running: true, step: "harvesting" });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ started: true }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => rebuildState });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () {
  this.open = () => {};
  this.send = () => { this.status = 200; this.responseText = JSON.stringify({ families: {} }); };
};
global.window = window; global.document = window.document;
const load = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
load("d3.min.js");
load("data.js");
(function () {
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", "/api/llm-families", false);
  xhr.send(null);
  const data = JSON.parse(xhr.responseText);
  data.__serverAvailable = true;      // these controls are local-only
  window.LLM_FAMILIES = data;
})();
load("llm_families.js");
load("app.js");
load("timeline.js");
load("sixdeg.js");
window.CarWeb.boot();
// Both buttons deliberately leave themselves disabled on success: the reload
// is what re-enables them. There is no reload here, so each section re-enables
// them itself rather than the next one silently clicking dead controls.
const reenable = () => ["llmreset-start", "llmreset-confirm", "llmreset-cancel",
                        "llmwipe-start", "llmwipe-confirm", "llmwipe-cancel"]
  .forEach(id => { window.document.getElementById(id).disabled = false; });

const $ = id => window.document.getElementById(id);

(async () => {
  // ---------- where they live ----------
  t("the buttons live in the Delete / Restore panel, as asked",
    !!$("deletepanel") && $("deletepanel").contains($("llmreset-section")));
  t("...alongside the existing rebuild controls",
    !!$("rebuild-section") && $("deletepanel").contains($("rebuild-section")));
  t("both start buttons are there", !!$("llmreset-start") && !!$("llmwipe-start"));
  t("...and neither Yes button is visible before it is asked for",
    $("llmreset-confirm").hidden && $("llmwipe-confirm").hidden);
  t("the panel explains which of the two datasets is which",
    /baked graph/i.test($("llmreset-section").textContent) &&
    /LLM layer/i.test($("llmreset-section").textContent));
  t("...and says a backup is written first",
    /llm_layer_backups/.test($("llmreset-section").textContent));

  // ---------- nothing happens on one click ----------
  {
    calls.length = 0;
    $("llmreset-start").click();
    await sleep(30);
    t("clicking 'wipe the LLM layer' only asks", calls.length === 0, calls.join(" | "));
    t("...and arms its own confirm", !$("llmreset-confirm").hidden);
    t("...while the other button's confirm stays hidden", $("llmwipe-confirm").hidden);
    t("...telling you what it clears",
      /splits|relationships/i.test($("llmreset-status").textContent),
      $("llmreset-status").textContent.slice(0, 70));
    $("llmreset-cancel").click();
    t("cancel puts it away with nothing done",
      $("llmreset-confirm").hidden && !$("llmreset-start").hidden && calls.length === 0);
  }

  // ---------- one armed at a time ----------
  {
    $("llmreset-start").click();
    $("llmwipe-start").click();
    await sleep(20);
    t("arming the second disarms the first -- two live Yes buttons is how the wrong one gets clicked",
      $("llmreset-confirm").hidden && !$("llmwipe-confirm").hidden);
    t("...and the warning names the slow half",
      /DBpedia/.test($("llmreset-status").textContent) &&
      /minutes/.test($("llmreset-status").textContent),
      $("llmreset-status").textContent.slice(0, 80));
    $("llmwipe-cancel").click();
  }

  // ---------- wipe the LLM layer ----------
  {
    calls.length = 0; reloaded = 0;
    $("llmreset-start").click();
    $("llmreset-confirm").click();
    for (let i = 0; i < 80 && !calls.some(c => c.includes("/api/llm-reset")); i++) await sleep(20);
    await sleep(40);
    t("it goes through the endpoint that backs the overlay up",
      calls.some(c => c === "POST /api/llm-reset"), calls.join(" | "));
    t("...rather than the page emptying the store itself",
      !calls.some(c => c === "POST /api/llm-families"), calls.join(" | "));
    t("...and does NOT rebuild the graph -- that is the other button",
      !calls.some(c => c.includes("POST /api/rebuild")), calls.join(" | "));
    t("it reports what was cleared", /834/.test($("llmreset-status").textContent),
      $("llmreset-status").textContent.slice(0, 90));
    t("...and where the backup went", /llm_layer_backups/.test($("llmreset-status").textContent),
      $("llmreset-status").textContent.slice(0, 120));
    await sleep(1600);
    // Not optional: data.js and llm_families_data.js are script tags, and the
    // running page would write its in-memory overlay straight back.
    t("...then reloads, because the page is still holding the old data", reloaded === 1, reloaded);
  }

  // ---------- wipe everything and rebuild ----------
  {
    reenable();
    calls.length = 0; reloaded = 0;
    rebuildState = { ok: true, running: false, scriptExists: true, step: "", elapsed: 42, log: [] };
    $("llmwipe-start").click();
    $("llmwipe-confirm").click();
    for (let i = 0; i < 100 && !calls.some(c => c === "POST /api/rebuild"); i++) await sleep(20);
    const order = calls.filter(c => /llm-reset|POST \/api\/rebuild/.test(c));
    t("start-from-scratch does both halves", order.length === 2, order.join(" -> "));
    t("...the wipe first, so the rebuild is not undone by a stale overlay",
      order[0] === "POST /api/llm-reset" && order[1] === "POST /api/rebuild",
      order.join(" -> "));
    t("...and the progress lands in this panel, not the other one",
      /rebuilding|starting the rebuild/i.test($("llmreset-status").textContent),
      $("llmreset-status").textContent.slice(0, 80));
    // Finish the rebuild and confirm it reloads from here too.
    rebuildState = { ok: true, running: false, scriptExists: true, step: "done", elapsed: 42, log: ["-- done --"] };
    for (let i = 0; i < 80 && !reloaded; i++) await sleep(60);
    t("...and it reloads when the rebuild finishes", reloaded === 1, reloaded);
  }

  // ---------- a server that isn't there ----------
  {
    reenable();
    calls.length = 0; reloaded = 0;
    window.fetch = () => Promise.reject(new Error("no server"));
    $("llmreset-start").click();
    $("llmreset-confirm").click();
    await sleep(120);
    t("with no local server it says so instead of pretending",
      /local server/.test($("llmreset-status").textContent),
      $("llmreset-status").textContent.slice(0, 80));
    t("...and does not reload as if it had worked", reloaded === 0, reloaded);
    t("...leaving the buttons usable again", !$("llmreset-start").disabled);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
