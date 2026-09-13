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

// ---- the sweep over what was already queued -----------------------------
{
  const weak = (key, a, b) => ({
    [key]: { status: "provisional", llmDiscovered: true, relType: "platform",
             famA: a.id, famB: b.id, genIdA: a.id, genIdB: b.id,
             codeA: a.label, codeB: b.label, reason: "proposed by overlapping production years only" },
  });
  const ion = car("m-saturn-ion", "Saturn", "Ion");
  const nodes = [
    car("m-audi-tt", "Audi", "TT"), car("m-audi-a3", "Audi", "A3"),
    car("m-skoda-octavia", "Škoda", "Octavia"), car("m-seat-leon", "SEAT", "León"),
    car("m-chev-captiva", "Chevrolet", "Captiva"), car("m-isuzu-trooper", "Isuzu", "Trooper"),
    ion,
  ];
  const rels = Object.assign({},
    weak("m-audi-tt|m-saturn-ion|platform", nodes[0], ion),
    weak("m-isuzu-trooper|m-saturn-ion|platform", nodes[5], ion),
    weak("m-chev-captiva|m-saturn-ion|platform", nodes[4], ion),   // SAME company as Saturn
    weak("m-audi-tt|m-audi-a3|platform", nodes[0], nodes[1]),
    weak("m-skoda-octavia|m-seat-leon|platform", nodes[2], nodes[3]));
  rels["m-confirmed|m-pair|platform"] = { status: "confirmed", llmDiscovered: true,
    famA: "m-audi-tt", famB: "m-saturn-ion", genIdA: "m-audi-tt", genIdB: "m-saturn-ion",
    relType: "platform" };

  const { LF: LF2, store } = freshLF(rels);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const dropped = LF2.pruneWeakRelations(byId);

  const left = Object.keys(store.relations || {});
  t("rule 1 clears the cross-company proposals", dropped.length >= 2, dropped.map(d => d.a + "<->" + d.b).join(", "));
  t("...and rule 2 takes the Saturn Ion's REMAINING one too, inside GM, "
    + "because it has already been rejected twice",
    !left.includes("m-chev-captiva|m-saturn-ion|platform"), left.join(", "));
  t("the plausible same-company pairs survive for review",
    left.includes("m-audi-tt|m-audi-a3|platform") && left.includes("m-skoda-octavia|m-seat-leon|platform"),
    left.join(", "));
  t("a CONFIRMED relation is never touched, whatever the companies",
    left.includes("m-confirmed|m-pair|platform"), left.join(", "));
  t("every rejection is recorded, so it is not proposed again",
    dropped.every(d => store.rejectedRelations[d.key] === true));
  t("...and the run reports them by name, not by key",
    dropped.every(d => /\w+ \w/.test(d.a) && /\w+ \w/.test(d.b)), JSON.stringify(dropped[0]));

  // Idempotent: nothing is left to find on a second pass.
  t("running it again finds nothing", LF2.pruneWeakRelations(byId).length === 0);
}

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
