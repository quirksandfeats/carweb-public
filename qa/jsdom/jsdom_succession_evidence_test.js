// A succession found by a code in the text is confirmed only when the two generations
// hand over in time (8 Nov 2026): the Dart (PF) was paired with the 2000 Neon.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
const check = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? " -- " + e : "")); };
function freshBareWindow(fetchImpl) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window } = dom;
  window.fetch = fetchImpl;
  global.window = window; global.document = window.document;
  window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  window.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return window;
}
const DART = code => "{{Infobox automobile\n| name = TestDodge Dart\n}}\n" +
  "The TestDodge Dart replaced the TestChrysler Neon#Second generation (" + code + "; 2000) compact cars in its markets.";
const NEON = "{{Infobox automobile\n| name = TestChrysler Neon\n}}\nA compact car.";
const infoA = { id: "fam-t-dart", make: "TestDodge", label: "Dart", wp: "TestDodge Dart", generations: [
  { id: "m-t-dart-pf", code: "Dart PF", year: 2012, end: 2016 } ] };
const infoB = { id: "fam-t-neon", make: "TestChrysler", label: "Neon", wp: "TestChrysler Neon", generations: [
  { id: "m-t-neon-pl", code: "Neon PL", year: 1994, end: 1999 },
  { id: "m-t-neon-pg26", code: "Neon PG26", year: 2000, end: 2005 },
  { id: "m-t-neon-x356", code: "Neon X356", year: 2016, end: 2020 } ] };
(async () => {
  const raw = { resolved: false, codeA: null, codeB: null, reason: "The articles do not say which generations." };
  for (const [code, want, label] of [["PG26", "provisional", "seven years apart: waits for review"], ["X356", "confirmed", "handing over the same year: confirmed"]]) {
    const window = freshBareWindow(url => Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": String(url).includes("Dart") ? DART(code) : NEON } } }) }));
    const e = await window.LlmFamilies.previewRelationResult(infoA, infoB, "succession", null, raw);
    check(`Dart PF and Neon ${code}, ${label}`, e && e.status === want && e.genIdB === "m-t-neon-" + code.toLowerCase(), e && `${e.status} ${e.genIdA} ${e.genIdB}`);
  }
  {
    const window = freshBareWindow(url => Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": String(url).includes("Dart") ? DART("PG26") : NEON } } }) }));
    const e = await window.LlmFamilies.previewRelationResult(infoA, infoB, "platform", null, raw);
    check("a platform pair is not held to a handover", e && e.status === "confirmed", e && e.status);
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
  process.exit(fails ? 1 : 0);
})();
