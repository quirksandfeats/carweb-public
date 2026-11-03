// A scanned car that is one generation of a nameplate is placed on it, and the nameplate is read for the rest.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const CAR = n => `{{Infobox automobile\n| name = ${n}\n| production = 1993-1996\n}}\nThe ${n} is a car.`;
const PAGES = {
  "Testa Falco": "{{Infobox automobile\n| name = Falco\n}}\nThe Falco.\n==XH==\n{{main|Testa Falco (Australia)}}\nA car.\n",
  "Testa Falco (XG)": CAR("Testa Falco (XG)"),
  "Testa Falco (XH)": CAR("Testa Falco (XH)"),
  "Testa Falco (Australia)": CAR("Testa Falco (Australia)"),
  "Testa Falco (1911)": CAR("Testa Falco (1911)"),
  "Testa Falco (V8 Supercar)": CAR("Testa Falco (V8 Supercar)"),
  "Testa Falco (W201)": CAR("Testa Falco (W201)"),
  "Testa Luna": "{{Infobox automobile\n| name = Luna\n| predecessor = [[Testa Luna (W201)]]\n}}\nThe Luna.",
  "Testa Luna (W201)": CAR("Testa Luna (W201)"),
  "Testa Sole": "'''Testa Sole''' may refer to:\n*[[Testa Sole (1954)]]\n*[[Testa Sole (2010)]]\n{{sia|cars}}",
  "Testa Sole (1954)": CAR("Testa Sole (1954)"),
  "Testa Sole (2010)": CAR("Testa Sole (2010)"),
  "Other Article": CAR("Other Article"),
};
const saved = [];
let modelAsked = 0;
function boot(server) {
  const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
  const { window: w } = dom;
  w.HTMLCanvasElement.prototype.getContext = fakeCtx;
  w.requestAnimationFrame = () => 1;
  w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
  w.fetch = async (url, init) => {
    const u = String(url);
    if (/\/api\/llm-families/.test(u)) { saved.push(init && init.body); return { ok: true, json: async () => ({}) }; }
    if (/\/api\/llm\/chat/.test(u)) {
      modelAsked++;
      const content = JSON.stringify({ hasMultipleGenerations: false, generations: [{ code: "XG", yearStart: 1993, yearEnd: 1996, designers: [], engineers: [], sharedPlatforms: [] }] });
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }
    if (!/wikipedia\.org/.test(u)) return { ok: true, json: async () => ({}), text: async () => "{}" };
    const page = new URL(u).searchParams.get("page");
    if (page && PAGES[page]) return { ok: true, json: async () => ({ parse: { title: page, wikitext: { "*": PAGES[page] } } }) };
    return { ok: true, json: async () => ({ query: { search: [] } }) };
  };
  w.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
  global.window = w; global.document = w.document;
  const ev = f => w.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
  ev("d3.min.js"); ev("data.js");
  w.LLM_FAMILIES = { settings: { reviewedV: 9 }, rejectedRelations: {}, renames: {}, userCars: {}, wpLinks: {}, mintedFacts: {}, relations: {}, families: {}, recheck: {}, __serverAvailable: !!server };
  for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]))
    if (f !== "d3.min.js" && f !== "data.js" && !/llm_families_data/.test(f)) ev(f);
  w.CarWeb.boot();
  return w;
}
const w = boot();
const LF = w.LlmFamilies;
const model = (id, label, wp, extra) => Object.assign({ id, type: "model", make: "Testa", label, wp }, extra || {});
const graph = () => {
  const nodes = [
    { id: "fam", type: "family", make: "Testa", label: "Falco", wp: "Testa Falco", year: 1960, end: 2016, generations: ["g-xf", "g-xh"] },
    model("g-xf", "Falco (XF)", "Testa Falco", { familyOf: "fam", year: 1984, end: 1988 }),
    model("g-xh", "Falco (XH)", "Testa Falco", { familyOf: "fam", year: 1996, end: 1999 }),
    model("xg", "Falco (XG)", "Testa Falco (XG)", { year: 1993, end: 1996 }),
    model("xh", "Falco (XH)", "Testa Falco (XH)", { year: 1996, end: 1999 }),
    model("aus", "Falco (Australia)", "Testa Falco (Australia)", { year: 1960, end: 2016 }),
    model("old", "Falco (1911)", "Testa Falco (1911)", { year: 1911, end: 1911 }),
    model("race", "Falco (V8 Supercar)", "Testa Falco (V8 Supercar)", { year: 2014 }),
    model("wrong", "Falco (G28)", "Other Article"),
    model("luna", "Luna", "Testa Luna", { year: 1990 }),
    model("w201", "Luna (W201)", "Testa Luna (W201)", { year: 1982, end: 1993 }),
    model("sole", "Sole", "Testa Sole", { year: 1954, designers: ["Someone"] }),
    model("s54", "Sole (1954)", "Testa Sole (1954)", { year: 1954, end: 1965 }),
    model("s10", "Sole (2010)", "Testa Sole (2010)", { year: 2010, end: 2020 }),
  ];
  return { nodes, links: [{ source: "xg", target: "other", type: "platform" }] };
};
const one = { generations: [{ code: "x" }] };
const on = id => !!LF.genPlacements()[id];
(async () => {
  const { nodes, links } = graph();
  const by = id => nodes.find(n => n.id === id);
  await LF.placeAsGeneration(by("xg"), nodes, one, "Testa Falco (XG)");
  t("a code in brackets is placed, with its own page", on("xg"));
  await LF.placeAsGeneration(by("old"), nodes, one, "Testa Falco (1911)");
  t("a year the nameplate's page never mentions stays a car of its own", !on("old"));
  await LF.placeAsGeneration(by("aus"), nodes, one, "Testa Falco (Australia)");
  t("a place the nameplate's page points at is placed", on("aus"));
  await LF.placeAsGeneration(by("race"), nodes, one, "Testa Falco (V8 Supercar)");
  t("a racing version is no generation", !on("race"));
  await LF.placeAsGeneration(by("wrong"), nodes, one, "Other Article");
  t("a page without the nameplate's name is another car's", !on("wrong"));
  await LF.placeAsGeneration(by("w201"), nodes, one, "Testa Luna (W201)");
  t("a car the nameplate calls its predecessor is not its generation", !on("w201"));
  await LF.placeAsGeneration(by("s10"), nodes, one, "Testa Sole (2010)");
  t("a year the nameplate's index lists is placed", on("s10"));
  t("and what else that index lists, already in the graph", on("s54"));
  await LF.placeAsGeneration(by("xh"), nodes, one, "Testa Falco (XH)");
  await LF.placeAsGeneration(by("xh"), nodes, { generations: [{ code: "a" }, { code: "b" }] }, "Testa Falco (XH)");

  t("every placement is applied", LF.applyGenerationPlacements(nodes, links) >= 5);
  t("no matching generation: it joins as a new one", by("xg").familyOf === "fam" && by("fam").generations.includes("xg"));
  t("keeping its own page", by("xg").wp === "Testa Falco (XG)" && by("xg").year === 1993 && by("xg").end === 1996);
  t("a matching code folds into that generation", by("xh").retired === true && by("xh").supersededBy === "g-xh");
  t("no matching code, years that agree at both ends and no page: not forced", by("aus").familyOf === "fam");
  t("its links stay with it", links.some(l => l.source === "xg" && l.type === "platform"));
  t("what stays apart stays apart", !by("old").familyOf && !by("race").familyOf && !by("wrong").familyOf && !by("w201").familyOf);
  const sole = by("sole");
  t("a plain nameplate becomes one with only the cars placed in it", sole.type === "family" && sole.generations.length === 2 && !nodes.some(n => n.id === "merge-sole-self"));
  t("keeping its own years and credits", sole.year === 1954 && sole.end == null && sole.designers.includes("Someone"));
  t("a second pass places nothing again", LF.applyGenerationPlacements(nodes, links) === 0);

  // Years that agree at both ends find a generation with no page of its own, whatever the overlap.
  const y = { nodes: [
    { id: "p", type: "family", make: "Testa", label: "Capo", wp: "Testa Capo", generations: ["a", "b", "c"] },
    model("a", "Capo Mk1", "Testa Capo", { familyOf: "p", year: 1985, end: 1994 }),
    model("b", "Capo SA30", "Testa Capo", { familyOf: "p", year: 1989, end: 1994 }),
    model("c", "Capo (Japan)", "Testa Capo (Japan)", { familyOf: "p", year: 1989, end: 1994 }),
    model("q", "Capo (Oz)", "Testa Capo (Oz)", { year: 1989, end: 1994 }),
    model("r", "Capo (Eu)", "Testa Capo (Eu)", { year: 1987, end: 1994 }),
  ], links: [] };
  LF.genPlacements().q = { plate: "p", said: "Oz", at: "x" };
  LF.genPlacements().r = { plate: "p", said: "Eu", at: "x" };
  LF.applyGenerationPlacements(y.nodes, y.links);
  const yb = id => y.nodes.find(n => n.id === id);
  t("the same years at both ends is the same car", yb("q").retired === true && yb("q").supersededBy === "b");
  t("sharing some years is not", !yb("r").retired && yb("r").familyOf === "p");
  // The whole of it, as a scan does it: the car is read, placed, and its nameplate read too.
  const s = boot(true), SF = s.LlmFamilies, g = graph();
  const fam = g.nodes.find(n => n.id === "fam"), car = g.nodes.find(n => n.id === "xg");
  const gens = ["g-xf", "g-xh"].map(id => g.nodes.find(n => n.id === id));
  let read = 0, entry = null;
  SF.setFreshRecheckRunner(async plate => {
    read++;
    entry = await SF.forceRecheckFamily(plate, gens, g.nodes, g.links, { keepRejections: true });
  });
  SF.placeInCascade("xg", null);
  await SF.checkNode(car, g.nodes, {});
  for (let i = 0; i < 200 && !entry; i++) await new Promise(r => setTimeout(r, 10));
  t("a scan places the car", !!SF.genPlacements().xg && SF.genPlacements().xg.plate === "fam", JSON.stringify(SF.genPlacements()));
  t("and reads its nameplate once", read === 1, read);
  t("at the car's own level", SF.cascadeDepthOf("fam") === SF.cascadeDepthOf("xg"), SF.cascadeDepthOf("fam"));
  t("that read only adds", !!(entry && entry.proposal && entry.proposal.addOnly), entry && entry.status);
  const unpaired = { id: "g9", type: "model", make: "Testa", label: "Falco Nine", familyOf: "fam", year: 1970, end: 1975 };
  const retired = SF.decideRecheck(fam, [gens[0], unpaired], { sections: [], sourceTitle: "Testa Falco",
    proposal: { generations: [{ code: "XF", yearStart: 1960, yearEnd: 1990 }], addOnly: true } }, g.nodes);
  t("and retires nothing it did not find", retired && retired.retire.length === 0);
  await new Promise(r => setTimeout(r, 400));
  t("the placement is saved", saved.some(b => /genPlacements/.test(String(b))));
  console.log(fails ? fails + " failed" : "all passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
