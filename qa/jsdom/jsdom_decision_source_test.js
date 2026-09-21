// A plain model found to hide several generations is confirmed and applied
// WITHOUT being asked -- a deliberate decision ("if a car is creating a
// nameplate for the first time... you do not need my approval"), made when
// the only way to trigger a check was to click a car and watch what happened.
//
// scripts/llm_agent.py changes that context: an unattended run applies a
// dozen of those that nobody looked at, and until now they were written to
// llm_families.json as plain status:"confirmed" -- indistinguishable from the
// ones a human approved. Reviewing a bad run meant archaeology.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const pendingChecks = [];
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

function freshLF() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "http://localhost:8077/", runScripts: "outside-only" });
  const w = dom.window;
  global.window = w; global.document = w.document;
  w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
  const written = [];
  w.fetch = async (url, opts) => {
    if (String(url).startsWith("/api/llm-families")) { written.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error("unexpected fetch " + url);
  };
  const entry = code => ({
    status: "provisional", sourceTitle: "Test Car",
    proposal: { hasMultipleGenerations: true,
                generations: [{ code, designers: ["A Designer"], engineers: [] }] },
  });
  w.LLM_FAMILIES = {
    families: { "m-one": entry("X1"), "m-two": entry("X2") },
    relations: {}, __serverAvailable: true,
  };
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return { LF: w.LlmFamilies, written };
}

{
  const { LF, written } = freshLF();
  t("a session starts out attributed to the person at the keyboard",
    LF.decisionSource() === "user", LF.decisionSource());

  LF.confirmNode("m-one");
  t("a confirmation made by hand is marked as the user's",
    LF.entryFor("m-one").decidedBy === "user", LF.entryFor("m-one").decidedBy);

  LF.setDecisionSource("agent");
  LF.confirmNode("m-two");
  t("...and one made during an agent run is marked as the agent's",
    LF.entryFor("m-two").decidedBy === "agent", LF.entryFor("m-two").decidedBy);

  t("the earlier decision is not retroactively reattributed",
    LF.entryFor("m-one").decidedBy === "user", LF.entryFor("m-one").decidedBy);

  // Checked once the writes have landed. persist() keeps one write in flight
  // and one waiting behind it (the overnight crash), so the body carrying
  // m-two goes out when the one carrying m-one returns -- a moment later,
  // not in the same breath.
  pendingChecks.push(async () => {
    await new Promise(r => setTimeout(r, 20));
    t("the mark is written to disk, not just held in memory",
      written.length >= 2 &&
      written[written.length - 1].families["m-two"].decidedBy === "agent",
      JSON.stringify(written[written.length - 1] && written[written.length - 1].families["m-two"]));
  });

  t("both are still confirmed -- this records WHO, it does not gate anything",
    LF.entryFor("m-one").status === "confirmed" && LF.entryFor("m-two").status === "confirmed");
}

// Only the two values exist. Anything else must not become a third source of
// truth about who approved a split.
{
  const { LF } = freshLF();
  LF.setDecisionSource("something else");
  t("an unrecognised source falls back to the person, never to the agent",
    LF.decisionSource() === "user", LF.decisionSource());
  LF.setDecisionSource("agent");
  LF.setDecisionSource("user");
  t("and it can be handed back", LF.decisionSource() === "user");
}

(async () => {
  for (const f of pendingChecks) await f();
  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
