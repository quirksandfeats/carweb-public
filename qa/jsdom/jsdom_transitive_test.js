// Real user request: "if car A and car B are related, and car B and car C are
// related, then car A and C are also related. However, the generations MUST be
// kept in mind when doing this relationship check with a nameplate of a car."
// Plus: the number of hops must be configurable.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "app", "llm_families.js"), "utf-8");
function slice(name) {
  const start = src.indexOf("\n  function " + name + "(");
  const after = src.indexOf("\n  function ", start + 10);
  const f = src.slice(start + 1, after);
  const lb = f.lastIndexOf("\n  }");
  return lb < 0 ? f : f.slice(0, lb + 4);
}
eval(src.match(/const TRANSITIVE_TYPES = [^\n]+/)[0] + "\n" +
     src.match(/const TRANSITIVE_MAX_PROPOSALS = [^\n]+/)[0] + "\n" +
     slice("inferTransitiveRelations"));

let fails = 0;
const t = (name, cond, extra) => { if (!cond) fails++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  -- " + extra : "")); };
const N = ids => ids.map(id => ({ id }));
const L = (a, b, type) => ({ source: a, target: b, type: type || "related" });
const pairs = r => r.map(x => [x.aId, x.cId].sort().join("~")).sort();

// ---- the basic claim ----------------------------------------------------
{
  const r = inferTransitiveRelations(N(["a","b","c"]), [L("a","b"), L("b","c")], { maxHops: 1 });
  t("A-B and B-C infers A-C", pairs(r).join() === "a~c", JSON.stringify(pairs(r)));
  t("...and records the car it went through", r[0].via.join() === "b", JSON.stringify(r[0].via));
  t("...and the hop count", r[0].hops === 1, r[0].hops);
}
// ---- generations are respected -----------------------------------------
{
  // A relates to the NAMEPLATE; a specific GENERATION of it relates to C.
  // Different nodes, so this must NOT chain.
  const nodes = N(["a", "fam-b", "b-gen3", "c"]);
  const links = [L("a", "fam-b"), L("b-gen3", "c"), L("fam-b", "b-gen3", "generation")];
  const r = inferTransitiveRelations(nodes, links, { maxHops: 1 });
  t("nameplate-level A-B does NOT chain through a generation-level B-C",
    r.length === 0, JSON.stringify(pairs(r)));
}
{
  // Both links touch the SAME generation -- this one is sound.
  const nodes = N(["a", "fam-b", "b-gen3", "c"]);
  const links = [L("a", "b-gen3"), L("b-gen3", "c"), L("fam-b", "b-gen3", "generation")];
  const r = inferTransitiveRelations(nodes, links, { maxHops: 1 });
  t("two links through the SAME generation do chain", pairs(r).join() === "a~c", JSON.stringify(pairs(r)));
}
{
  // Two DIFFERENT generations of the same nameplate must not bridge.
  const nodes = N(["a", "b-gen1", "b-gen3", "c", "fam-b"]);
  const links = [L("a","b-gen1"), L("b-gen3","c"),
                 L("fam-b","b-gen1","generation"), L("fam-b","b-gen3","generation")];
  const r = inferTransitiveRelations(nodes, links, { maxHops: 1 });
  t("two DIFFERENT generations of one nameplate don't bridge", r.length === 0, JSON.stringify(pairs(r)));
}
// ---- hop configuration --------------------------------------------------
{
  const nodes = N(["a","b","c","d"]);
  const links = [L("a","b"), L("b","c"), L("c","d")];
  t("maxHops 0 turns it off entirely",
    inferTransitiveRelations(nodes, links, { maxHops: 0 }).length === 0);
  const one = inferTransitiveRelations(nodes, links, { maxHops: 1 });
  t("maxHops 1 gives A-C and B-D but not A-D",
    pairs(one).join() === "a~c,b~d", JSON.stringify(pairs(one)));
  const two = inferTransitiveRelations(nodes, links, { maxHops: 2 });
  t("maxHops 2 also reaches A-D", pairs(two).includes("a~d"), JSON.stringify(pairs(two)));
  t("...and reports it as two hops",
    two.find(x => [x.aId,x.cId].sort().join("~") === "a~d").hops === 2);
}
// ---- things it must not propose ----------------------------------------
{
  const r = inferTransitiveRelations(N(["a","b","c"]), [L("a","b"), L("b","c"), L("a","c")], { maxHops: 1 });
  t("a pair that's already linked isn't re-proposed", r.length === 0, JSON.stringify(pairs(r)));
}
{
  const r = inferTransitiveRelations(N(["a","b","c"]),
    [L("a","b","succession"), L("b","c","succession")], { maxHops: 1 });
  t("succession chains are not treated as relatedness", r.length === 0, JSON.stringify(pairs(r)));
}
{
  const nodes = [{id:"a"},{id:"b",retired:true},{id:"c"}];
  const r = inferTransitiveRelations(nodes, [L("a","b"), L("b","c")], { maxHops: 1 });
  t("a deleted car doesn't act as a stepping stone", r.length === 0, JSON.stringify(pairs(r)));
}
{
  const r = inferTransitiveRelations(N(["a","b","c"]), [L("a","b","platform"), L("b","c","platform")], { maxHops: 1 });
  t("an all-platform chain is reported as a platform relationship", r[0].relType === "platform", r[0].relType);
  const mixed = inferTransitiveRelations(N(["a","b","c"]), [L("a","b","platform"), L("b","c","related")], { maxHops: 1 });
  t("a mixed chain falls back to the looser 'related'", mixed[0].relType === "related", mixed[0].relType);
}
{
  // shortest path wins
  const nodes = N(["a","b","c","x"]);
  const links = [L("a","b"), L("b","c"), L("a","x"), L("x","b")];
  const r = inferTransitiveRelations(nodes, links, { maxHops: 2 });
  const ac = r.find(p => [p.aId,p.cId].sort().join("~") === "a~c");
  t("the shortest chain is the one reported", ac && ac.hops === 1, ac && ac.hops);
}
{
  const nodes = N(["a","b","c"]), links = [L("a","b"), L("b","c")];
  t("a caller-supplied skip filter is honoured (rejected pairs stay rejected)",
    inferTransitiveRelations(nodes, links, { maxHops: 1, skip: (x,y) => x === "a" || y === "a" }).length === 0);
  t("the proposal cap is respected",
    inferTransitiveRelations(N(["a","b","c","d","e"]),
      [L("a","b"),L("b","c"),L("c","d"),L("d","e")], { maxHops: 2, cap: 2 }).length <= 2);
}
// ---- the hop setting: server default, user override, persistence ---------
// Real user request: "I also want that the program lets me configure how many
// hops to do, similar to how there's a setting for picking the number of hops
// for the LLM to perform for the models."
{
  const { JSDOM } = require("jsdom");
  const APP = path.resolve(__dirname, "..", "..", "app");
  let saved = null;
  function boot(bootData) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>",
      { url: "http://localhost:8077/", runScripts: "outside-only" });
    const w = dom.window;
    global.window = w; global.document = w.document;
    w.LLM_FAMILIES = Object.assign({ __serverAvailable: true }, bootData);
    w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
    w.fetch = async (url, opts) => {
      if (opts && opts.method === "POST") { saved = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; }
      return { ok: true, json: async () => bootData };
    };
    w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
    return w.LlmFamilies;
  }

  const LF = boot({ families: {}, __config: { transitiveMaxHops: 2 } });
  t("serve.py's TRANSITIVE_MAX_HOPS is the default", LF.transitiveMaxHops() === 2, LF.transitiveMaxHops());
  LF.setTransitiveMaxHops(3);
  t("the app's own setting overrides it", LF.transitiveMaxHops() === 3, LF.transitiveMaxHops());
  t("the override is written to disk",
    saved && saved.settings && saved.settings.transitiveMaxHops === 3,
    JSON.stringify(saved && saved.settings));
  t("out-of-range values are clamped, not accepted",
    LF.setTransitiveMaxHops(99) === 4 && LF.setTransitiveMaxHops(-5) === 0);
  LF.setTransitiveMaxHops(3);

  LF.rejectTransitive("transitive:a|c", { note: "not really related" });
  t("a rejection is written to disk",
    saved.transitive && saved.transitive["transitive:a|c"].status === "rejected");

  const LF2 = boot(Object.assign({ __config: { transitiveMaxHops: 2 } }, saved));
  t("the setting survives a reload", LF2.transitiveMaxHops() === 3, LF2.transitiveMaxHops());
  t("a rejection survives a reload", !!LF2.transitiveEntryFor("transitive:a|c"));

  // and the decision actually suppresses the proposal
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const links = [{ source: "a", target: "b", type: "related" }, { source: "b", target: "c", type: "related" }];
  t("a rejected pair is never proposed again",
    LF2.transitiveProposals(nodes, links).length === 0,
    JSON.stringify(LF2.transitiveProposals(nodes, links)));
  const LF3 = boot({ families: {}, __config: { transitiveMaxHops: 1 } });
  const props = LF3.transitiveProposals(nodes, links);
  t("an undecided pair IS proposed, and marked for review",
    props.length === 1 && props[0].status === "provisional", JSON.stringify(props));
  t("turning hops down to 0 stops proposals entirely",
    (LF3.setTransitiveMaxHops(0), LF3.transitiveProposals(nodes, links).length === 0));
}

// ---- answering a stuck match from connections already in the graph -------
// "where the LLM doesn't quite have enough information to confirm itself and
// would otherwise ask me to confirm myself. It should also check the
// transitive relationships and see if it can answer this matching question
// itself first, before asking me for approval."
{
  const { JSDOM } = require("jsdom");
  const APP = path.resolve(__dirname, "..", "..", "app");
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "http://localhost:8077/", runScripts: "outside-only" });
  const w = dom.window;
  global.window = w; global.document = w.document;
  w.LLM_FAMILIES = { __serverAvailable: false, families: {} };
  w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
  w.fetch = async () => { throw new Error("no network in this test"); };
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  const answer = w.LlmFamilies.transitiveAnswerFor;

  const A = { id: "fam-a", generations: [{ id: "a1", code: "A Mk1" }, { id: "a2", code: "A Mk2" }] };
  const B = { id: "fam-b", generations: [{ id: "b1", code: "B Mk1" }, { id: "b2", code: "B Mk2" }] };
  const nodes = [{ id: "a1" }, { id: "a2" }, { id: "b1" }, { id: "b2" }, { id: "mid", label: "Middle Car" }];
  const L = (s, t, type) => ({ source: s, target: t, type: type || "related" });

  let r = answer(A, B, nodes, [L("a2", "mid"), L("mid", "b1")]);
  t("one chain through one car answers which generations pair up",
    r && r.genIdA === "a2" && r.genIdB === "b1", JSON.stringify(r));
  t("...and names the car it went through", r && r.viaLabel === "Middle Car", r && r.viaLabel);

  r = answer(A, B, nodes, [L("a1", "mid"), L("a2", "mid"), L("mid", "b1")]);
  t("two possible pairings is not an answer — the user still decides", r === null, JSON.stringify(r));

  r = answer(A, B, nodes, [L("a2", "b1")]);
  t("a direct link is not a chain", r === null, JSON.stringify(r));

  r = answer(A, B, nodes, [L("a2", "mid", "succession"), L("mid", "b1", "succession")]);
  t("succession chains still don't count", r === null, JSON.stringify(r));

  const retired = nodes.map(n => n.id === "mid" ? { id: "mid", label: "Middle Car", retired: true } : n);
  r = answer(A, B, retired, [L("a2", "mid"), L("mid", "b1")]);
  t("a deleted car can't be the link in the chain", r === null, JSON.stringify(r));

  t("no graph passed means no answer, never a crash", answer(A, B, null, null) === null);
}

console.log("\n" + fails + " failure(s) (total)");
process.exit(fails ? 1 : 0);
