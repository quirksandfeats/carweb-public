// Real user report: "I queued up the mercedes c class to be scanned ... the
// number of cars in the queue increased all the way to over 100." With the
// cascade depth at 1.
//
// A car whose article belongs to another car defers to it and, if that owner
// was never read, starts the owner's check. That check started with no
// recorded distance, so it counted as the car the user clicked (depth 0), and
// its partners passed the budget again; each of them deferring kicked ITS
// owner at depth 0 in turn. The walk renewed its allowance at every
// deferral. The owner reads the same article, so it is at the same distance.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
const fakeCtx = () => new Proxy({ measureText: () => ({ width: 10 }) },
  { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1; window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
// Every article fetch answers with a page titled after what was asked; the
// model is never reached (the owner's check fails fast, which is fine -- only
// the distance it was started at matters here).
window.fetch = (url) => {
  const m = String(url).match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    return Promise.resolve({ ok: true, json: async () => ({ parse: { title, wikitext: { "*": "{{Infobox automobile}}" } } }) });
  }
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    D.nodes.push({ id: "mk-t-chev", type: "make", label: "Chevrolet", year: 1911 });
    D.nodes.push({ id: "m-t-clicked", type: "model", label: "Clicked", make: "Chevrolet", wp: "Chevrolet Clicked", year: 1990 });
    // The partner, and the car that owns its article
    D.nodes.push({ id: "m-t-acadian", type: "model", label: "Acadian", make: "Chevrolet", wp: "Testmobile Chevette", year: 1976 });
    D.nodes.push({ id: "m-t-chevette", type: "model", label: "Chevette", make: "Testmobile", wp: "Testmobile Chevette", year: 1975 });
    // A car nobody asked about, which names a car that was never checked
    D.nodes.push({ id: "m-t-faraway", type: "model", label: "Faraway", make: "Chevrolet", wp: "Chevrolet Faraway", year: 1960 });
    D.nodes.push({ id: "m-t-unchecked", type: "model", label: "Unchecked", make: "Chevrolet", wp: "Chevrolet Unchecked", year: 1961 });
    D.nodes.push({ id: "m-t-unchecked2", type: "model", label: "Unchecked Two", make: "Chevrolet", wp: "Chevrolet Unchecked Two", year: 1962 });
    D.nodes.push({ id: "fam-t-plate", type: "family", label: "Plate", make: "Chevrolet", wp: "Chevrolet Plate", year: 1990, generations: ["g-t-plate-1"] });
    D.nodes.push({ id: "g-t-plate-1", type: "model", label: "Plate Mk1", make: "Chevrolet", familyOf: "fam-t-plate", wp: "Chevrolet Plate", year: 1990 });
    D.nodes.push({ id: "m-t-series70", type: "model", label: "Series 70", make: "Chevrolet", wp: "Chevrolet Series 70", year: 1936 });
    D.nodes.push({ id: "m-t-deferrer", type: "model", label: "No. 4", make: "Chevrolet", wp: "Chevrolet No. 4", year: 2021 });
    const now = new Date().toISOString();
    window.LLM_FAMILIES = { families: {
        // "DS No. 4" -> "DS N°4": the car it defers to is minted later in
        // boot, from the proposal that named it, and has a confirmed entry.
        "m-t-deferrer": { status: "same-article", checkedAt: now, sourceTitle: "Chevrolet No. 4",
                          sameAs: "llm-related-t-ghost", sameAsLabel: "Chevrolet N°4", attempts: 1 },
        "llm-related-t-ghost": { status: "confirmed", checkedAt: now, sourceTitle: "Chevrolet No. 4",
                                 proposal: { hasMultipleGenerations: false, generations: [] } },
      }, relations: {}, recheck: {}, settings: { cascadeMaxDepth: 1 }, __serverAvailable: true,
      // What the first version of the generation-name rule did to it.
      renames: { "m-t-series70": { label: "Series", previousLabel: "Series 70", kind: "model", auto: true,
                                   renamedAt: now, reason: "split under 70, one of its own generations" } } };
  }
  window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
}
const cw = window.CarWeb; cw.boot();
const LF = window.LlmFamilies;

(async () => {
  // ---------- a model name is not a generation code ----------
  check("an automatic rename that cut a model number off is undone",
        cw.byId.get("m-t-series70").label === "Series 70", cw.byId.get("m-t-series70").label);
  for (const l of ["Series 70", "Pacifica (minivan)", "Barracuda (1970)", "200 / 25", "BMC ADO16"])
    check(`"${l}" does not end in a generation code`, !LF.ownCodeShape(l));
  for (const l of ["Silvia (S13)", "80 (B1)", "Escort Mk3", "B-Class (W247)"])
    check(`"${l}" does`, !!LF.ownCodeShape(l));
  check("a deferral to a car minted later in boot, which holds a reading, is kept",
        (LF.entryFor("m-t-deferrer") || {}).status === "same-article", JSON.stringify(LF.entryFor("m-t-deferrer")));
  check("...and is not put back on the resume list", !LF.pendingWork().saved, LF.pendingWork().saved);
  check("a car started on behalf of another is one hop further out",
        LF.placeInCascade("m-t-acadian", "m-t-clicked") === 1, LF.cascadeDepthOf("m-t-acadian"));
  check("...and a distance once given is kept", LF.placeInCascade("m-t-acadian", "m-t-chevette") === 1);

  const r = await LF.sameArticleOwner(cw.byId.get("m-t-acadian"), cw.nodes);
  check("(fixture) the partner defers to the car that owns its article",
        r && r.owner && r.owner.id === "m-t-chevette", r && r.owner && r.owner.id);
  check("the owner's check starts at the partner's distance, not as a new starting point",
        LF.cascadeDepthOf("m-t-chevette") === 1, LF.cascadeDepthOf("m-t-chevette"));
  check("...so, at depth 1, the owner's own partners are not followed",
        !LF.cascadeAllowedFrom("m-t-chevette"));

  // ---------- a replay of someone else's stored mentions ----------
  // The second half of the same report: after a check lands, the page
  // replays every platform mention in the graph, and each one naming a car
  // with no entry scheduled it -- from origins nobody engaged.
  LF.setBackgroundAllowed(true);
  LF.setEngaged("m-t-clicked");
  const before = LF.pendingWork().partners.length;
  LF.schedulePartnerCheck(cw.byId.get("m-t-unchecked"), cw.nodes, "m-t-faraway");
  check("a mention replayed from a car outside the cascade schedules nothing",
        LF.pendingWork().partners.length === before && !LF.pendingWork().checks.includes("m-t-unchecked"),
        JSON.stringify(LF.pendingWork()));
  check("...so the car it names is still at no distance", LF.cascadeDepthIn("m-t-unchecked", cw.nodes) === null);
  LF.setEngaged("g-t-plate-1");
  check("a nameplate counts as engaged when one of its generations is open",
        LF.cascadeDepthIn("fam-t-plate", cw.nodes) === 0);
  LF.schedulePartnerCheck(cw.byId.get("m-t-unchecked2"), cw.nodes, "fam-t-plate");
  check("...and its own mentions are still followed", LF.cascadeDepthOf("m-t-unchecked2") === 1,
        LF.cascadeDepthIn("m-t-unchecked2", cw.nodes));

  console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
