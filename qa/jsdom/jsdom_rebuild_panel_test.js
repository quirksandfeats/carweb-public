// Real user request: "in the delete/restore section of the tools section,
// there's a button which reloads the entire data.js file from scratch, which
// would then show the snapshot being from today's date".
//
// Covers the wiring only -- serve.py's side has its own test
// (qa/qa_serve_rebuild.py) which never runs the real rebuild script.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
const $ = id => window.document.getElementById(id);

check("the rebuild section exists inside the Delete/Restore panel",
  !!$("rebuild-section") && $("deletepanel").contains($("rebuild-section")));
check("it has a start button, a confirm and a cancel", !!$("rebuild-start") && !!$("rebuild-confirm") && !!$("rebuild-cancel"));
check("confirm and cancel start hidden (one click doesn't fire it)",
  $("rebuild-confirm").hidden === true && $("rebuild-cancel").hidden === true);

// Pull initRebuildPanel out of app.js and run it against this DOM.
const src = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
const start = src.indexOf("\n  function initRebuildPanel() {");
const end = src.indexOf("\n  function initDeletePanel() {");
const fnSrc = src.slice(start + 1, end).replace(/\n  \}\s*$/, "\n  }");

let posted = null, phase = "running";
window.fetch = async (url, opts) => {
  if (opts && opts.method === "POST") { posted = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true, started: true }) }; }
  if (phase === "idle") return { ok: true, json: async () => ({ running: false, ok: null, scriptExists: true, step: "", log: [] }) };
  if (phase === "running") return { ok: true, json: async () => ({ running: true, step: "harvesting fresh data", elapsed: 4, log: [] }) };
  return { ok: true, json: async () => ({ running: false, ok: true, elapsed: 9, step: "done", log: [] }) };
};
let reloaded = false;
const locStub = { reload: () => { reloaded = true; } };

(async () => {
  phase = "idle";
  new window.Function("document", "fetch", "location", "setInterval", "clearInterval", "setTimeout",
    fnSrc + "\n  initRebuildPanel();")(window.document, window.fetch, locStub,
      window.setInterval.bind(window), window.clearInterval.bind(window), window.setTimeout.bind(window));
  await sleep(30);

  $("rebuild-start").click();
  check("clicking the button asks for confirmation instead of firing",
    $("rebuild-confirm").hidden === false && posted === null, "posted=" + JSON.stringify(posted));
  check("...and the warning mentions how long it takes",
    /few minutes|internet/i.test($("rebuild-status").textContent), $("rebuild-status").textContent);

  $("rebuild-cancel").click();
  check("cancel backs out cleanly", $("rebuild-confirm").hidden === true && posted === null);

  $("rebuild-skipharvest").checked = true;
  $("rebuild-start").click();
  check("the skip-download warning is milder", !/re-downloads/i.test($("rebuild-status").textContent),
    $("rebuild-status").textContent);
  phase = "running";
  $("rebuild-confirm").click();
  await sleep(60);
  check("confirming posts the rebuild, honouring the skip checkbox",
    posted && posted.skipHarvest === true, JSON.stringify(posted));

  await sleep(1700);
  check("progress shows the script's current step",
    /harvesting fresh data/.test($("rebuild-status").textContent), $("rebuild-status").textContent);

  phase = "done";
  await sleep(1700);
  check("on success it says done", /done in/.test($("rebuild-status").textContent), $("rebuild-status").textContent);
  await sleep(1400);
  check("...and reloads so the new data.js takes effect", reloaded === true);

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
