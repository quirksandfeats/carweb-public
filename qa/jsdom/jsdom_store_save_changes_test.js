// What a save tells serve.py it changed. Real user report: approvals made in
// his own tab while the agent's page was scanning were lost -- each page
// POSTed its whole copy of the store and the file kept the last one. A save
// now carries "__changed" (entries set or removed per part, and the parts
// saved whole), and serve.py writes only those over what is on disk: see
// qa/qa_serve_store_merge.py for that half.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { url: "http://localhost:8077/", runScripts: "outside-only" });
const w = dom.window;
global.window = w; global.document = w.document;
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
const raw = [];
w.fetch = async (url, opts) => {
  if (String(url) === "/api/llm-families" && opts && opts.method === "POST") { raw.push(opts.body); return { ok: true, json: async () => ({}) }; }
  return { ok: true, json: async () => ({}) };
};
const entry = code => ({
  status: "provisional", sourceTitle: "Test Car",
  proposal: { hasMultipleGenerations: true, generations: [{ code, designers: [], engineers: [] }] },
});
w.LLM_FAMILIES = {
  families: { "m-one": entry("X1"), "m-two": entry("X2"), "m-three": entry("X3") },
  relations: {}, __serverAvailable: true,
};
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;

(async () => {
  await new Promise(r => setTimeout(r, 50));
  t("loading the page writes nothing", raw.length === 0, raw.length);

  LF.confirmNode("m-two");
  await new Promise(r => setTimeout(r, 50));
  t("a decision is saved", raw.length >= 1, raw.length);
  const last = JSON.parse(raw[raw.length - 1]);
  const changed = last.__changed;
  t("the save lists exactly the entry that changed",
    JSON.stringify(changed && changed.set) === JSON.stringify({ families: ["m-two"] }), JSON.stringify(changed));
  t("...and nothing removed", changed && Object.keys(changed.del).length === 0, JSON.stringify(changed && changed.del));
  const body = Object.assign({}, last); delete body.__changed;
  t("the rest of the body is still the whole store, as a full save would send it",
    body.families && Object.keys(body.families).length === 3 && body.families["m-two"].status === "confirmed");

  LF.confirmNode("m-three");
  await new Promise(r => setTimeout(r, 50));
  const next = JSON.parse(raw[raw.length - 1]).__changed;
  t("the next save lists only what changed since the last one, not m-two again",
    JSON.stringify(next && next.set) === JSON.stringify({ families: ["m-three"] }), JSON.stringify(next));

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
