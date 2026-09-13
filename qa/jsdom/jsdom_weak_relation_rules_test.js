// 32 shared-platform proposals had piled up awaiting review, resting on
// nothing but a year overlap or a substring name match. They split cleanly:
//
//   plausible   Audi TT <-> Audi A3, Škoda Octavia <-> SEAT León,
//               Karmann Ghia <-> Beetle, TrailBlazer <-> GMC Envoy
//   nonsense    Audi TT <-> Saturn Ion, Škoda Octavia <-> Daren Mk.3,
//               Cupra Formentor <-> Hyundai Eon, SEAT Toledo <-> Leapmotor A05
//
// The line between them is corporate ownership, which is the one thing a
// substring match can never check. Two rules follow:
//
//   1. different companies -> reject, no review
//   2. a car rule 1 has thrown out twice is matching on its name, not on a
//      platform -- its remaining weak proposals go too
//
// Nothing confirmed is ever touched, and a rejection is the same reversible
// record a manual "no" writes.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

function freshLF(relations) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "http://localhost:8077/", runScripts: "outside-only" });
  const w = dom.window;
  global.window = w; global.document = w.document;
  w.CARDATA = { meta: { version: 5 }, nodes: [], links: [] };
  w.LLM_FAMILIES = { families: {}, relations: relations || {}, rejectedRelations: {}, __serverAvailable: false };
  w.fetch = async () => ({ ok: true, json: async () => ({}) });
  w.eval(fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8"));
  return { LF: w.LlmFamilies, store: w.LLM_FAMILIES };
}

const { LF } = freshLF();

// ---- the ownership table itself ----------------------------------------
const rel = (a, b) => LF.makeRelationship(a, b);
t("a marque is the same company as itself", rel("Audi", "Audi") === "same");
t("VW Group is one company", rel("Audi", "Škoda") === "same" && rel("SEAT", "Volkswagen") === "same");
t("GM is one company", rel("Chevrolet", "GMC") === "same" && rel("Oldsmobile", "Buick") === "same");
t("Stellantis is one company", rel("Jeep", "Peugeot") === "same" && rel("Dodge", "Fiat") === "same");
t("Audi and Saturn are not", rel("Audi", "Saturn") === "different");
t("nor Cupra and Hyundai", rel("Cupra", "Hyundai") === "different");
t("nor SEAT and Leapmotor", rel("SEAT", "Leapmotor") === "different");
t("a tiny independent marque is a company of its own, not an unknown",
  rel("Škoda", "Daren") === "different" && rel("Isuzu", "Kline") === "different");

// Historical ownership counts, because Ford Escape <-> Mazda Tribute is real.
t("historical ownership counts -- Mazda under Ford", rel("Ford", "Mazda") === "same");
t("...and a marque can belong to two groups across its life -- Volvo",
  rel("Ford", "Volvo") === "same" && rel("Geely", "Volvo") === "same");
t("a make nobody listed is UNKNOWN, not foreign -- nothing is rejected on ignorance",
  rel("Audi", "Some New Brand") === "unknown" && rel("", "Audi") === "unknown");

// ---- rule 1, on nodes ---------------------------------------------------
const car = (id, make, label) => ({ id, make, label, type: "model" });
t("rule 1 rejects two cars from unrelated companies",
  !!LF.weakProposalRejection(car("m-audi-tt", "Audi", "TT"), car("m-saturn-ion", "Saturn", "Ion")));
t("...and says why, in terms of the companies",
  /not part of the same company/.test(
    LF.weakProposalRejection(car("a", "Audi", "TT"), car("b", "Saturn", "Ion")).why));
t("rule 1 leaves a pair inside one company alone",
  LF.weakProposalRejection(car("a", "Audi", "TT"), car("b", "Škoda", "Octavia")) === null);
t("...and a pair from the same marque",
  LF.weakProposalRejection(car("a", "Volkswagen", "Beetle"), car("b", "Volkswagen", "Type 3")) === null);
t("...and a pair it cannot judge",
  LF.weakProposalRejection(car("a", "Audi", "TT"), car("b", "Some New Brand", "X")) === null);

// ---- deciding what was already queued -----------------------------------
// Real user calls: "year-overlap guess is actually fine ... for a string that
// only matches a substring, that's correct that it's too much of a stretch and
// to not try to do a match." So the queue is not triaged, it is DECIDED: the
// year-overlap ones are real links, the substring ones are not matches at all.
{
  const weak = (key, a, b, kind) => ({
    [key]: { status: "provisional", llmDiscovered: true, relType: "platform",
             famA: a.id, famB: b.id, genIdA: a.id, genIdB: b.id,
             codeA: a.label, codeB: b.label,
             // The two reason strings the OLD code actually persisted, verbatim
             // -- resolveWeakRelations matches on exactly these so it can
             // never touch a proposal written after the policy landed (it runs
             // on every boot, not just once).
             reason: kind === "years"
               ? "proposed by overlapping production years only (a shared-platform/rebadge mention was found alongside this generation's own text, but which specific generation of the OTHER nameplate it refers to was guessed from year overlap, not stated explicitly) -- please verify before accepting"
               : "proposed from a loosely-matched shared-platform/rebadge mention (the matched nameplate name wasn't an exact match, just a substring overlap) -- please verify this is really the right car before accepting" },
  });
  const ion = car("m-saturn-ion", "Saturn", "Ion");
  const daren = car("m-daren-mk3", "Daren", "Mk.3");
  const nodes = [
    car("m-vw-ghia", "Volkswagen", "Karmann Ghia"), car("m-vw-beetle", "Volkswagen", "Beetle"),
    car("m-chev-tb", "Chevrolet", "TrailBlazer"), car("m-gmc-envoy", "GMC", "Envoy"),
    car("m-audi-tt", "Audi", "TT"), car("m-vw-touran", "Volkswagen", "Touran"),
    car("m-isuzu-trooper", "Isuzu", "Trooper"),
    ion, daren,
  ];
  const rels = Object.assign({},
    // year overlap, same company -> real links
    weak("m-vw-ghia|m-vw-beetle|platform", nodes[0], nodes[1], "years"),
    weak("m-chev-tb|m-gmc-envoy|platform", nodes[2], nodes[3], "years"),
    // year overlap, but across companies -- the one bad apple in that bucket
    weak("m-vw-touran|m-daren-mk3|platform", nodes[5], daren, "years"),
    // substring matches -> not matches at all, whatever the companies
    weak("m-audi-tt|m-saturn-ion|platform", nodes[4], ion, "loose"),
    weak("m-isuzu-trooper|m-saturn-ion|platform", nodes[6], ion, "loose"));
  rels["m-already|m-decided|platform"] = { status: "confirmed", llmDiscovered: true,
    famA: "m-audi-tt", famB: "m-saturn-ion", genIdA: "m-audi-tt", genIdB: "m-saturn-ion",
    relType: "platform" };

  const { LF: LF2, store } = freshLF(rels);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const r = LF2.resolveWeakRelations(byId);
  const left = Object.keys(store.relations || {});
  const statusOf = k => (store.relations[k] || {}).status;

  t("a year overlap under an exact nameplate match becomes a real link",
    statusOf("m-vw-ghia|m-vw-beetle|platform") === "confirmed" &&
    statusOf("m-chev-tb|m-gmc-envoy|platform") === "confirmed",
    JSON.stringify(r.confirmed.map(c => c.a + "<->" + c.b)));
  t("...and stops saying 'please verify'",
    !/verify/i.test(store.relations["m-vw-ghia|m-vw-beetle|platform"].reason),
    store.relations["m-vw-ghia|m-vw-beetle|platform"].reason);

  t("a substring match is dropped, not queued",
    !left.includes("m-audi-tt|m-saturn-ion|platform") &&
    !left.includes("m-isuzu-trooper|m-saturn-ion|platform"), left.join(", "));
  t("a year overlap ACROSS companies is dropped too -- the company rule is "
    + "what stands in for looseness there",
    !left.includes("m-vw-touran|m-daren-mk3|platform"), left.join(", "));

  t("nothing is left awaiting review", left.every(k => statusOf(k) !== "provisional"), left.join(", "));
  t("a decision already made is never touched",
    statusOf("m-already|m-decided|platform") === "confirmed");
  t("every drop is recorded, so it is not proposed again",
    r.dropped.every(d => store.rejectedRelations[d.key] === true));
  t("both halves are reported by name", r.confirmed.length === 2 && r.dropped.length === 3,
    `confirmed ${r.confirmed.length}, dropped ${r.dropped.length}`);

  const again = LF2.resolveWeakRelations(byId);
  t("running it again finds nothing", again.confirmed.length === 0 && again.dropped.length === 0);
}

// ---- and it only ever decides the BACKLOG -------------------------------
// resolveWeakRelations runs on every boot, not once. A proposal written
// AFTER the policy landed is already the product of that policy -- a
// re-check the user asked for, or a sanity check that came back unsure --
// and is waiting for a person to look at it. An earlier draft matched on
// the loose phrase "overlapping production years only" alone, which would
// have deleted exactly those on the next reload.
{
  const a = car("m-post-a", "Nissan", "Nova"), b = car("m-post-b", "Kline Kar", "Roadster");
  const post = (key, reason) => ({
    [key]: { status: "provisional", llmDiscovered: true, relType: "platform",
             famA: a.id, famB: b.id, genIdA: a.id, genIdB: b.id,
             codeA: a.label, codeB: b.label, reason },
  });
  const rels = Object.assign({},
    post("m-post-a|m-post-b|platform",
         "proposed by overlapping production years only, on top of a nameplate name that only "
         + "matched as a substring -- please verify this is really the right car before accepting"),
    post("m-post-a|m-post-c|platform",
         'flagged by the local LLM sanity check as the same car as "Kline Kar Roadster" '
         + "(confidence: low) -- not sure -- please verify this is really the right car before accepting"),
    post("m-post-a|m-post-d|platform",
         'proposed from a loosely-matched shared-platform/rebadge mention ("Kline Kar Roadster" only '
         + "overlapped this car's name as a substring) -- surfaced because you asked for this re-check "
         + "rather than dropped, but please verify this is really the right car before accepting"));

  const { LF: LF3, store } = freshLF(rels);
  const r = LF3.resolveWeakRelations(new Map([[a.id, a], [b.id, b]]));
  t("a proposal written after the policy is left for the user to review",
    Object.keys(store.relations).length === 3 &&
    Object.values(store.relations).every(e => e.status === "provisional"),
    Object.values(store.relations).map(e => e.status).join(", "));
  t("...and is not reported as decided either",
    r.confirmed.length === 0 && r.dropped.length === 0,
    `confirmed ${r.confirmed.length}, dropped ${r.dropped.length}`);
}

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
