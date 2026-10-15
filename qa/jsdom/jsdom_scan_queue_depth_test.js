// The page's own scan queue runs each request at the cascade depth it was
// added with (1 by default, up to 7 on the machine itself), and puts the
// configured depth back afterwards.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/", runScripts: "outside-only" });
const w = dom.window; global.window = w; global.document = w.document;
w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
w.fetch = async () => ({ ok: true, json: async () => ({}) });
w.LLM_FAMILIES = { families: {}, jobs: [], __serverAvailable: true, __config: { cascadeMaxDepth: 7 } };
w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
const LF = w.LlmFamilies;
const seen = [];
LF.registerJobRunner("check", async () => { seen.push(LF.cascadeMaxDepth()); });
(async () => {
  LF.startJobs();
  const a = LF.enqueueJob({ kind: "check", targetId: "m-a", label: "A" });
  const b = LF.enqueueJob({ kind: "check", targetId: "m-b", label: "B", depth: 3 });
  const c = LF.enqueueJob({ kind: "check", targetId: "m-c", label: "C", depth: 12 });
  t("a request added with no depth gets 1", a.depth === 1, a.depth);
  t("...one asking for more than 7 is held to 7", c.depth === 7, c.depth);
  for (let i = 0; i < 40 && seen.length < 3; i++) await new Promise(r => setTimeout(r, 25));
  t("each runs at its own depth", seen.join() === "1,3,7", seen.join());
  t("...and the configured depth is back afterwards", LF.cascadeMaxDepth() === 7, LF.cascadeMaxDepth());
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
