// A nameplate split earlier in the same scan is not read again when the scan
// reaches it from another car. 53 of the first 98 re-checks waiting for review
// on 14 Oct 2026 were that: the agent split the Infiniti QX50 into "J50" and
// "J55", reached it again six hours later, and the second read named them
// "First generation (J50)" and "Second generation (J55)".
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

function run(decidedOffsetMs) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8077/", runScripts: "outside-only" });
  const w = dom.window; global.window = w; global.document = w.document;
  w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
  w.fetch = async () => ({ ok: true, json: async () => ({}) });
  w.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true, __config: { cascadeMaxDepth: 7 } };
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  const LF = w.LlmFamilies;
  const seed = { id: "m-seed", type: "model", label: "Seed", make: "T" };
  const fam = { id: "m-qx50", type: "family", label: "QX50", make: "T", generations: ["g1", "g2"] };
  const nodes = [seed, fam, { id: "g1", type: "model", label: "QX50 (J50)", familyOf: "m-qx50" }, { id: "g2", type: "model", label: "QX50 (J55)", familyOf: "m-qx50" }];
  const read = [];
  LF.setFreshRecheckRunner(car => { read.push(car.id); return Promise.resolve(); });
  LF.setBackgroundAllowed(true);
  LF.setEngaged(seed.id);
  LF.beginFreshScan(seed.id);
  const store = w.LLM_FAMILIES;
  const started = Date.parse(LF.fullScanState ? LF.fullScanState().startedAt : new Date().toISOString());
  store.families["m-qx50"] = { status: "confirmed", decidedAt: new Date(Date.now() + decidedOffsetMs).toISOString(),
                               proposal: { generations: [{ code: "J50" }, { code: "J55" }] } };
  LF.schedulePartnerCheck(fam, nodes, seed.id);
  return new Promise(r => setTimeout(() => r(read), 80));
}

(async () => {
  const same = await run(1000);
  t("a nameplate split during this scan is not read again", same.length === 0, same.join());
  const before = await run(-86400000);
  t("...one split before the scan began still is", before.join() === "m-qx50", before.join());
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
