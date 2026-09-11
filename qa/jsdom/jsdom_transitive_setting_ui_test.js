// The hop-count control in the LLM Debug panel: reads the current value,
// writes an override, clamps, and reports how many suggestions that yields.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const dom = new JSDOM(fs.readFileSync(path.join(APP, "index.html"), "utf-8"),
  { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const w = dom.window;
const $ = id => w.document.getElementById(id);

t("the hop control exists in the LLM Debug panel",
  !!$("transitive-hops") && $("llmdebug").contains($("transitive-hops")));
t("it offers Off through 3 steps", $("transitive-hops").options.length === 4);
t("the panel explains that generations are respected",
  /[Gg]enerations are respected/.test($("transitive-section").textContent));
t("...and that nothing is applied automatically",
  /nothing is added on its own/i.test($("transitive-section").textContent));

// drive initTransitiveSetting against a stub LlmFamilies
const src = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
const start = src.indexOf("\n  function initTransitiveSetting() {");
const end = src.indexOf("\n  function initDeletePanel() {");
const fnSrc = src.slice(start + 1, end);

let stored = 1, proposals = 5;
const LF = {
  transitiveMaxHops: () => stored,
  setTransitiveMaxHops: n => (stored = Math.max(0, Math.min(4, n | 0))),
  transitiveProposals: () => new Array(proposals).fill({}),
};
new w.Function("document", "window", "nodes", "links", "refreshCounts",
  fnSrc + "\n  initTransitiveSetting();")(w.document, { LlmFamilies: LF }, [], [], () => {});

t("the control shows the stored value on open", $("transitive-hops").value === "1", $("transitive-hops").value);
t("...and how many suggestions that produces",
  /5 suggestions/.test($("transitive-hops-note").textContent), $("transitive-hops-note").textContent);

$("transitive-hops").value = "2";
$("transitive-hops").onchange();
t("changing it saves the new value", stored === 2, stored);

proposals = 1;
$("transitive-hops").value = "0";
$("transitive-hops").onchange();
t("Off is saved as 0", stored === 0, stored);
t("...and says no suggestions will be made",
  /no suggestions/.test($("transitive-hops-note").textContent), $("transitive-hops-note").textContent);

proposals = 1; stored = 1;
$("transitive-hops").value = "1";
$("transitive-hops").onchange();
t("singular wording for one suggestion",
  /1 suggestion\b/.test($("transitive-hops-note").textContent), $("transitive-hops-note").textContent);

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
