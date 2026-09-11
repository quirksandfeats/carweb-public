// Verifies the "find ALL generations" prompt/cap improvements: the raised
// cue cap (20 -> 60), the strengthened SYSTEM_PROMPT, and the reinforcing
// instruction repeated at the end of the user turn.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app"); // portable: qa/jsdom/<this file> -> ../../app
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
global.window = window;
global.document = window.document;

// Build a synthetic article with 30 distinct generation paragraphs (chassis
// codes TC1..TC30), each also mentioning a "facelift" so both GEN_CUE_RE and
// the general noise pattern are exercised -- the old 20-cap would drop the
// last 10 of these.
let wikitext = "{{Infobox automobile\n| name = Test Car\n}}\n\n";
for (let i = 1; i <= 30; i++) {
  wikitext += `The Mk${i} generation (chassis code TC${i}) was produced starting in ${1950 + i}. `
    + `It received a facelift partway through its run.\n\n`;
}

let capturedOllamaBody = null;
window.fetch = (url, opts) => {
  if (String(url).includes("wikipedia.org")) {
    return Promise.resolve({
      ok: true,
      json: async () => ({ parse: { wikitext: { "*": wikitext } } }),
    });
  }
  if (String(url).includes("/api/llm/chat")) {
    capturedOllamaBody = JSON.parse(opts.body);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ hasMultipleGenerations: false, generations: [] }) } }] }),
    });
  }
  return Promise.resolve({ ok: true, json: async () => ({}) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { this.status = 200; this.responseText = "{}"; }; };

function loadScript(file) { window.eval(fs.readFileSync(path.join(APP, file), "utf-8")); }
// Seed serverAvailable=true (checkNode() is a no-op otherwise)
window.LLM_FAMILIES = { families: {}, __serverAvailable: true };
loadScript("llm_families.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}

const LF = window.LlmFamilies;
check("serverAvailable is true (checkNode will actually run)", LF.serverAvailable === true);

const node = { id: "m-test-car", make: "Test", label: "Car", wp: "Test Car" };

LF.checkNode(node).then(() => {
  check("a request reached Ollama", !!capturedOllamaBody);
  const userMsg = capturedOllamaBody.messages.find(m => m.role === "user").content;
  const sysMsg = capturedOllamaBody.messages.find(m => m.role === "system").content;

  check("system prompt instructs exhaustiveness", /EXHAUSTIVE/.test(sysMsg));
  check("system prompt warns against stopping early", /stopping early/i.test(sysMsg));
  check("user turn repeats the 'display every generation' instruction (the one that worked in manual testing)",
    /every generation/i.test(userMsg) && /not just a couple/i.test(userMsg));

  // count how many of the 30 synthetic chassis codes made it into the prompt
  let found = 0;
  for (let i = 1; i <= 30; i++) if (userMsg.includes(`TC${i}`)) found++;
  check("more than 20 of the 30 synthetic generations reached the prompt (old cap was 20)", found > 20, found);
  check("all 30 synthetic generations reached the prompt (new cap is 60)", found === 30, found);

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => {
  console.log("FAIL threw: " + (e.stack || e));
  process.exit(1);
});
